import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { normalizeSettings, mergeSettings } from './settings.js';
import { IDENT, isQualified, splitQualified } from '../public/runtime/modules.js';

// Every artifact kind lives in its own folder under a project's data folder. Some kinds are a
// pair of files - a JSON document plus a code behind - and docKey names the property the
// document is carried under: a form has a "layout", a workflow has a "definition".
// The scoped kinds - forms and scripts - live inside a module: data/modules/<Module>/<dir>, and
// are named "Module.Name" everywhere outside the module folder. Jobs and workflows stay at the
// top of the data folder and keep plain names.
// A note is a lone markdown file at the top of the data folder: a code-only kind whose "code" is
// the markdown, written for the people on the project (and, later, for an agent's context).
// Declaration order is also the explorer order (the Data group is placed first by the tree route).
//
// The store is a function of a folder: bindStore(dataDir) gives the operations over one project,
// and the module-level exports are the default instance over this process's own project
// (config.dataDir) - what a runner uses. The preview host, which serves every project, binds a
// store per project folder and shares this one implementation.
export const KINDS = {
  'forms': { dir: 'forms', label: 'Forms', suffix: '.form.json', hasDoc: true, docKey: 'layout', scoped: true },
  'client-scripts': { dir: 'client-scripts', label: 'Client Scripts', suffix: '.js', hasDoc: false, scoped: true },
  'server-scripts': { dir: 'server-scripts', label: 'Server Scripts', suffix: '.js', hasDoc: false, scoped: true },
  'jobs': { dir: 'jobs', label: 'Jobs', suffix: '.job.json', hasDoc: true, docKey: 'job', hasCode: false },
  'workflows': { dir: 'workflows', label: 'Workflows', suffix: '.workflow.json', hasDoc: true, docKey: 'definition', hasCode: false },
  'apis': { dir: 'apis', label: 'APIs', suffix: '.api.json', hasDoc: true, docKey: 'api', hasCode: false },
  'notes': { dir: 'notes', label: 'Notes', suffix: '.md', hasDoc: false }
};

export const SCOPED_KINDS = Object.keys(KINDS).filter((kind) => KINDS[kind].scoped);
export const MODULES_DIR = 'modules';
export const DEFAULT_MODULE = 'Main';

// The first defence against path traversal: a name can only ever be an identifier (or two
// of them joined by a dot, for a scoped kind). The second is insideFile below: a name that is
// fine can still lead out of the folder through a link planted inside it.
const NAME_RE = IDENT;

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

export function assertKind(kind) {
  if (!Object.hasOwn(KINDS, kind)) throw new StoreError(`Unknown artifact kind "${kind}".`, 404);
  return kind;
}

export function assertName(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new StoreError(`Invalid name "${name}". Use letters, digits and underscore, starting with a letter.`);
  }
  return name;
}

// "Module.Name": what a form or script is called outside its module folder.
export function assertQualified(name) {
  if (!isQualified(name)) {
    throw new StoreError(`Invalid name "${name}". A form or script is named "Module.Name", such as "Main.Details".`);
  }
  return name;
}

// The name an artifact of this kind is stored under: qualified for a scoped kind, plain otherwise.
export function assertArtifact(kind, name) {
  return KINDS[assertKind(kind)].scoped ? assertQualified(name) : assertName(name);
}

// { module, name } of a scoped artifact; a plain kind has no module and the name as is.
function parts(kind, name) {
  assertArtifact(kind, name);
  return KINDS[kind].scoped ? splitQualified(name) : { module: null, name };
}

// --- containment ----------------------------------------------------------------
// A project's own code can write anything inside its folder, a link included: a script file
// that is really a link to another project's, an images entry that is really config.json. A
// process that opens the file where it seems to be would follow the link. So a file the store
// opens must really be inside the folder: its parent, resolved through any links, lies under
// the resolved root, and the file itself is not a link. A missing parent (a write makes it) is
// judged by its nearest existing ancestor. Nothing is opened before the check passes.

function outsideOf(realRoot, real) {
  const rel = path.relative(realRoot, real);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

async function nearestReal(dir) {
  let at = dir;
  for (;;) {
    try {
      return await fs.realpath(at);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const up = path.dirname(at);
      if (up === at) throw err;
      at = up;
    }
  }
}

function nearestRealSync(dir) {
  let at = dir;
  for (;;) {
    try {
      return fsSync.realpathSync(at);
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') throw err;
      const up = path.dirname(at);
      if (up === at) throw err;
      at = up;
    }
  }
}

const refused = (file) => new StoreError(`${path.basename(file)} is not inside the project's own folder; it is not opened.`, 400);

// The file, once it is known to be inside `rootDir`; a StoreError otherwise. A root that does
// not exist yet holds nothing to escape from.
export async function insideFile(rootDir, file) {
  let realRoot;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch (err) {
    if (err.code === 'ENOENT') return file;
    throw err;
  }
  if (outsideOf(realRoot, await nearestReal(path.dirname(file)))) throw refused(file);
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) throw refused(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return file;
}

export function insideFileSync(rootDir, file) {
  let realRoot;
  try {
    realRoot = fsSync.realpathSync(rootDir);
  } catch (err) {
    if (err.code === 'ENOENT') return file;
    throw err;
  }
  if (outsideOf(realRoot, nearestRealSync(path.dirname(file)))) throw refused(file);
  try {
    if (fsSync.lstatSync(file).isSymbolicLink()) throw refused(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return file;
}

// Whether a folder the store lists or writes into is really inside the root: false for one
// that is a link out of it (or a link at all), true for one that is missing.
export async function insideDir(rootDir, dir) {
  let realRoot;
  try {
    realRoot = await fs.realpath(rootDir);
  } catch (err) {
    if (err.code === 'ENOENT') return true;
    throw err;
  }
  try {
    if ((await fs.lstat(dir)).isSymbolicLink()) return false;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return true;
    throw err;
  }
  return !outsideOf(realRoot, await fs.realpath(dir));
}

// --- the defaults of a new artifact -----------------------------------------------

export function defaultLayout(name) {
  return { name, type: 'form', text: name, width: 800, height: 560, props: {}, events: {}, children: [] };
}

export function defaultDefinition(name) {
  return {
    name,
    nodes: [{ id: 'start1', type: 'start', x: 60, y: 140, props: {} }],
    edges: []
  };
}

export function defaultJob(name) {
  return {
    name,
    kind: 'script',
    target: '',
    args: null,
    schedule: { kind: 'every', every: '1h' },
    enabled: false
  };
}

// An API starts disabled and pointing at nothing: the quick setup fills it in.
export function defaultApi(name) {
  return {
    name,
    method: 'GET',
    route: `/${name}`,
    target: '',
    args: 'named',
    auth: 'any',
    roles: [],
    enabled: false,
    description: ''
  };
}

function defaultDoc(kind, name) {
  if (kind === 'workflows') return defaultDefinition(name);
  if (kind === 'jobs') return defaultJob(name);
  if (kind === 'apis') return defaultApi(name);
  return defaultLayout(name);
}

function defaultCode(kind, qualified, template) {
  // A note starts as its own heading; its name is plain, not "Module.Name".
  if (kind === 'notes') return `# ${qualified}\n\n`;
  const { module, name } = splitQualified(qualified);
  // The server script the Inspector's "+" makes beside an empty dataSource: one select() that
  // takes the control's arguments in order and answers with rows.
  if (kind === 'server-scripts' && template === 'data-source') {
    return [
      `// Server script "${name}" of module ${module}: a data source for a bound control.`,
      `// A control whose dataSource is '${name}.select' calls it with its dataArgs (or reload(args)) in`,
      '// order, and shows what it returns. Available: require, callFunction, context, user, console,',
      '// fetch, dbQuery, dbRun, getSecret, startWorkflow, runBackground',
      '',
      'async function select(...args) {',
      '  return dbQuery(`',
      '    SELECT *',
      '    FROM ...',
      '  `, args);',
      '}',
      ''
    ].join('\n');
  }
  if (kind === 'forms') {
    return [
      `// Code behind for form "${name}" of module ${module}.`,
      '// Handlers are top level functions, e.g. async function btnOk_OnClick(sender, e) { ... }',
      '// Available: require, server (server.callFunction, server.require, server.fileUrl, server.downloadFile), form (form.args, form.data, form.all, form.navigate, form.open, form.showModal, form.showDrawer, form.showPopup, form.close, form.closeAll), app (app.user, app.navigate), context',
      "// Server scripts: import { fn } from 'server:name';  or  const s = server.require('name'); await s.fn();  or  await server.callFunction('name.fn', [args])",
      `// A name reaches this module ('Details', 'customers.list'); prefix another module's ('Utils.Details').`,
      "// Dynamic controls: let btn = new Button({ text: 'Hi' }); form.controls.add(btn); btn.on('onClick', fn)",
      '',
      'async function Form_OnLoad(sender, e) {',
      '}',
      ''
    ].join('\n');
  }
  if (kind === 'client-scripts') {
    return [
      `// Client script "${name}" of module ${module}: a library of functions. Every top-level function`,
      `// is available to a code behind either way (the export keyword is optional):`,
      `//   import { hello } from '${name}';     or     const { hello } = require('${name}');`,
      `// From another module the name carries the module: import { hello } from '${module}.${name}';`,
      "// context.module is this script's module, context.qualifiedName its full name.",
      '',
      'function hello(who) {',
      "  return 'Hello ' + who;",
      '}',
      '',
      '// Run (F5) in the designer calls test() and shows what it returns; a form never does.',
      'function test() {',
      "  return hello('world');",
      '}',
      ''
    ].join('\n');
  }
  return [
    `// Server script "${name}" of module ${module}: a library of functions.`,
    `// A form of this module calls one with server.callFunction('${name}.functionName', [args]); from another`,
    `// module, a workflow or a job the name carries the module: '${module}.${name}.functionName'.`,
    `// Another server script imports them: import { hello } from '${name}';  or  const { hello } = require('${name}');`,
    '// Available: require, callFunction, context, user, console, fetch, dbQuery, dbRun, getSecret, startWorkflow, runBackground',
    '',
    'function hello(who) {',
    "  return 'Hello ' + who;",
    '}',
    '',
    '// Run (F5) in the designer calls test() and shows what it returns; the running app never does.',
    'function test() {',
    "  return hello('world');",
    '}',
    ''
  ].join('\n');
}

// The document inside a form file carries the short name: a form moves between modules as a
// plain file move, and the runtime's form id stays an identifier.
function shortName(kind, name) {
  return parts(kind, name).name;
}

// --- a store over one folder ------------------------------------------------------

// `where` is the project's data folder, or a function that gives it (the default instance
// follows config.dataDir, which a test may move).
export function bindStore(where) {
  const root = typeof where === 'function' ? where : () => where;
  const inside = (file) => insideFile(root(), file);

  function modulesDir() {
    return path.join(root(), MODULES_DIR);
  }

  function moduleDir(module) {
    return path.join(modulesDir(), assertName(module));
  }

  function dirOf(kind, module = null) {
    const { dir, scoped } = KINDS[assertKind(kind)];
    return scoped ? path.join(moduleDir(module), dir) : path.join(root(), dir);
  }

  // A doc kind's code behind is always .js; a code-only kind's file carries the kind's suffix
  // (.js for a script, .md for a note).
  function codePath(kind, name) {
    const { hasDoc, suffix } = KINDS[assertKind(kind)];
    const p = parts(kind, name);
    return path.join(dirOf(kind, p.module), `${p.name}${hasDoc ? '.js' : suffix}`);
  }

  function docPath(kind, name) {
    const { suffix } = KINDS[assertKind(kind)];
    const p = parts(kind, name);
    return path.join(dirOf(kind, p.module), `${p.name}${suffix}`);
  }

  function layoutPath(name) {
    return docPath('forms', name);
  }

  async function readDirs(dir) {
    if (!(await insideDir(root(), dir))) return [];
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  // The modules, Main first and the rest alphabetically.
  async function listModules() {
    const names = (await readDirs(modulesDir())).filter((n) => NAME_RE.test(n));
    return names.sort((a, b) => (a === DEFAULT_MODULE ? -1 : b === DEFAULT_MODULE ? 1 : a.localeCompare(b)));
  }

  // A folder, not a link: a module that is a link is no module.
  async function moduleExists(module) {
    try {
      return (await fs.lstat(moduleDir(module))).isDirectory();
    } catch {
      return false;
    }
  }

  async function ensureModuleDirs(module) {
    if (!(await insideDir(root(), modulesDir()))) throw refused(modulesDir());
    for (const kind of SCOPED_KINDS) await fs.mkdir(dirOf(kind, module), { recursive: true });
  }

  async function createModule(module) {
    assertName(module);
    if (await moduleExists(module)) throw new StoreError(`Module "${module}" already exists.`, 409);
    await ensureModuleDirs(module);
    return { module, created: true };
  }

  // The folder moves; nothing that names the module - code, settings, workflow or job targets -
  // is rewritten, the same as renaming a form.
  async function renameModule(module, newName) {
    assertName(module);
    assertName(newName);
    if (module === newName) return { module };
    if (!(await moduleExists(module))) throw new StoreError(`Module "${module}" does not exist.`, 404);
    if (await moduleExists(newName)) throw new StoreError(`Module "${newName}" already exists.`, 409);
    if (!(await insideDir(root(), modulesDir()))) throw refused(modulesDir());
    await fs.rename(moduleDir(module), moduleDir(newName));
    return { module: newName, renamed: true };
  }

  async function removeModule(module) {
    assertName(module);
    if (!(await moduleExists(module))) throw new StoreError(`Module "${module}" does not exist.`, 404);
    await fs.rm(moduleDir(module), { recursive: true, force: true });
    return { module, deleted: true };
  }

  // A data folder written before modules existed: forms and scripts loose at the top. The server
  // refuses to run on one until tools/migrate-modules.mjs has moved them.
  async function legacyLayout() {
    if ((await readDirs(root())).includes(MODULES_DIR)) return false;
    for (const kind of SCOPED_KINDS) {
      let entries;
      try {
        entries = await fs.readdir(path.join(root(), KINDS[kind].dir));
      } catch {
        continue;
      }
      if (entries.some((f) => f.endsWith(KINDS[kind].suffix))) return true;
    }
    return false;
  }

  async function ensureDirs() {
    for (const kind of Object.keys(KINDS)) if (!KINDS[kind].scoped) await fs.mkdir(dirOf(kind), { recursive: true });
    await fs.mkdir(modulesDir(), { recursive: true });
    // An empty project starts with one module, so there is somewhere to put the first form.
    if ((await listModules()).length === 0) await ensureModuleDirs(DEFAULT_MODULE);
    await fs.mkdir(path.join(root(), 'images'), { recursive: true });
  }

  // --- the project itself: data/project.json ---------------------------------
  // The name, the shell and its menu, the authentication and mail settings. Read once and kept
  // in memory, because the runtime consults the settings on every request; a write or a reload
  // replaces the copy in one step, so a request guard never sees an empty cache in between.

  let projectCache = null;
  let onAuthEnabled = null;

  function projectFile() {
    return path.join(root(), 'project.json');
  }

  async function loadProject() {
    let raw = {};
    try {
      raw = JSON.parse(await fs.readFile(await inside(projectFile()), 'utf8'));
    } catch {
      /* missing, unreadable or not the project's own: the defaults */
    }
    return normalizeSettings(raw).settings;
  }

  async function readProject() {
    if (!projectCache) projectCache = await loadProject();
    return projectCache;
  }

  // The file as it is now, swapped into the cache whole: what a change made elsewhere calls.
  async function reloadProject() {
    projectCache = await loadProject();
    return projectCache;
  }

  // The settings as last read, for code that cannot await (request guards). Null before the
  // first read; the server reads once at boot.
  function currentSettings() {
    return projectCache;
  }

  // A patch over the current settings: { name } alone renames, a whole object replaces. Anything
  // invalid refuses the write with every problem listed.
  async function writeProject(patch = {}) {
    const current = await readProject();
    const { settings, errors } = normalizeSettings(mergeSettings(current, patch));
    if (errors.length) throw new StoreError(errors.join(' '));
    const authTurnedOn = settings.auth.enabled && !current.auth.enabled;
    await fs.mkdir(root(), { recursive: true });
    await fs.writeFile(await inside(projectFile()), `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    projectCache = settings;
    if (authTurnedOn) await onAuthEnabled?.();
    return settings;
  }

  // Turning authentication on has to create its tables; the database module registers itself
  // here rather than being imported, since it imports this module for its errors.
  function setAuthEnabledHook(fn) {
    onAuthEnabled = fn;
  }

  async function listIn(dir, suffix) {
    if (!(await insideDir(root(), dir))) return [];
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return entries
      .filter((f) => f.endsWith(suffix))
      .map((f) => f.slice(0, -suffix.length))
      .filter((n) => NAME_RE.test(n))
      .sort((a, b) => a.localeCompare(b));
  }

  // The names of a kind: plain for jobs and workflows, "Module.Name" for forms and scripts, module
  // by module in the modules' order.
  async function list(kind) {
    const { suffix, scoped } = KINDS[assertKind(kind)];
    if (!scoped) return listIn(dirOf(kind), suffix);
    const out = [];
    for (const module of await listModules()) {
      for (const name of await listIn(dirOf(kind, module), suffix)) out.push(`${module}.${name}`);
    }
    return out;
  }

  // The explorer's groups: the modules first (so an empty module still shows), then every kind
  // with its names.
  async function tree() {
    const kinds = Object.keys(KINDS);
    const lists = await Promise.all(kinds.map(list));
    return [
      { kind: 'modules', label: 'Modules', items: await listModules() },
      ...kinds.map((kind, i) => ({ kind, label: KINDS[kind].label, items: lists[i] }))
    ];
  }

  async function exists(kind, name) {
    const file = KINDS[assertKind(kind)].hasDoc ? docPath(kind, name) : codePath(kind, name);
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  async function readText(file, fallback) {
    try {
      return await fs.readFile(await inside(file), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' && fallback !== undefined) return fallback;
      throw err;
    }
  }

  async function read(kind, name) {
    assertKind(kind);
    assertArtifact(kind, name);
    if (!(await exists(kind, name))) throw new StoreError(`${kind}/${name} does not exist.`, 404);

    const { hasDoc, docKey } = KINDS[kind];
    if (hasDoc) {
      const raw = await readText(docPath(kind, name));
      let doc;
      try {
        doc = JSON.parse(raw);
      } catch (err) {
        throw new StoreError(`"${name}" has an invalid ${docKey} file: ${err.message}`, 500);
      }
      doc.name = shortName(kind, name);
      if (KINDS[kind].hasCode === false) return { kind, name, [docKey]: doc };
      return { kind, name, [docKey]: doc, code: await readText(codePath(kind, name), '') };
    }
    return { kind, name, code: await readText(codePath(kind, name), '') };
  }

  async function write(kind, name, payload) {
    assertKind(kind);
    const p = parts(kind, name);
    if (KINDS[kind].scoped && !(await moduleExists(p.module))) throw new StoreError(`Module "${p.module}" does not exist.`, 404);
    await fs.mkdir(dirOf(kind, p.module), { recursive: true });
    const { hasDoc, docKey } = KINDS[kind];
    const code = payload.code;

    if (hasDoc) {
      const doc = payload[docKey];
      if (doc && typeof doc === 'object') {
        doc.name = p.name;
        await fs.writeFile(await inside(docPath(kind, name)), `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
      }
      if (KINDS[kind].hasCode !== false && typeof code === 'string') {
        await fs.writeFile(await inside(codePath(kind, name)), code, 'utf8');
      }
    } else {
      if (typeof code !== 'string') throw new StoreError('A script or a note needs its "code" property.');
      await fs.writeFile(await inside(codePath(kind, name)), code, 'utf8');
    }
    return read(kind, name);
  }

  // `template` picks a starting code other than the kind's usual one ('data-source' for a server
  // script); an unknown one is the usual.
  async function create(kind, name, { template } = {}) {
    assertKind(kind);
    assertArtifact(kind, name);
    if (await exists(kind, name)) throw new StoreError(`${kind}/${name} already exists.`, 409);
    const { hasDoc, docKey, hasCode } = KINDS[kind];
    return write(kind, name, {
      ...(hasDoc ? { [docKey]: defaultDoc(kind, shortName(kind, name)) } : {}),
      ...(hasCode === false ? {} : { code: defaultCode(kind, name, template) })
    });
  }

  // Removing a link removes the link, never what it points at, so no containment check here:
  // it is how a planted one is got rid of.
  async function remove(kind, name) {
    assertKind(kind);
    assertArtifact(kind, name);
    if (!(await exists(kind, name))) throw new StoreError(`${kind}/${name} does not exist.`, 404);
    if (KINDS[kind].hasCode !== false) await fs.rm(codePath(kind, name), { force: true });
    if (KINDS[kind].hasDoc) await fs.rm(docPath(kind, name), { force: true });
    return { kind, name, deleted: true };
  }

  // For a scoped kind the new name may carry another module: the rename is then a move.
  async function rename(kind, name, newName) {
    assertKind(kind);
    assertArtifact(kind, name);
    assertArtifact(kind, newName);
    if (name === newName) return read(kind, name);
    if (!(await exists(kind, name))) throw new StoreError(`${kind}/${name} does not exist.`, 404);
    if (await exists(kind, newName)) throw new StoreError(`${kind}/${newName} already exists.`, 409);

    const current = await read(kind, name);
    if (KINDS[kind].hasDoc) current[KINDS[kind].docKey].name = shortName(kind, newName);
    await write(kind, newName, current);
    await remove(kind, name);
    return read(kind, newName);
  }

  // A copy under a new name: the document with the copy's own short name, the code behind as it
  // is (it names controls by id, which the copy keeps). A job's copy starts with its schedule
  // off, so a duplicate never fires by itself; an API's copy starts disabled, since its route
  // is the original's.
  async function duplicate(kind, name, newName) {
    assertKind(kind);
    assertArtifact(kind, name);
    assertArtifact(kind, newName);
    if (!(await exists(kind, name))) throw new StoreError(`${kind}/${name} does not exist.`, 404);
    if (await exists(kind, newName)) throw new StoreError(`${kind}/${newName} already exists.`, 409);
    const copy = await read(kind, name);
    if (KINDS[kind].hasDoc) {
      copy[KINDS[kind].docKey].name = shortName(kind, newName);
      if (kind === 'jobs') copy.job.enabled = false;
      if (kind === 'apis') copy.api.enabled = false;
    }
    return write(kind, newName, copy);
  }

  return {
    get dataDir() {
      return root();
    },
    modulesDir,
    moduleDir,
    codePath,
    docPath,
    layoutPath,
    projectFile,
    listModules,
    moduleExists,
    createModule,
    renameModule,
    removeModule,
    legacyLayout,
    ensureDirs,
    readProject,
    reloadProject,
    currentSettings,
    writeProject,
    setAuthEnabledHook,
    list,
    tree,
    exists,
    read,
    write,
    create,
    remove,
    rename,
    duplicate
  };
}

// The default instance: this process's own project.
const own = bindStore(() => config.dataDir);

export const modulesDir = own.modulesDir;
export const moduleDir = own.moduleDir;
export const codePath = own.codePath;
export const docPath = own.docPath;
export const layoutPath = own.layoutPath;
export const projectFile = own.projectFile;
export const listModules = own.listModules;
export const moduleExists = own.moduleExists;
export const createModule = own.createModule;
export const renameModule = own.renameModule;
export const removeModule = own.removeModule;
export const legacyLayout = own.legacyLayout;
export const ensureDirs = own.ensureDirs;
export const readProject = own.readProject;
export const reloadProject = own.reloadProject;
export const currentSettings = own.currentSettings;
export const writeProject = own.writeProject;
export const setAuthEnabledHook = own.setAuthEnabledHook;
export const list = own.list;
export const tree = own.tree;
export const exists = own.exists;
export const read = own.read;
export const write = own.write;
export const create = own.create;
export const remove = own.remove;
export const rename = own.rename;
export const duplicate = own.duplicate;
