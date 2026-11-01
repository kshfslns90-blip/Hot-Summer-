import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { codePath, assertQualified, StoreError } from './store.js';
import { service as filesService } from './files.js';
import { scanTopLevelNames, scanRequires } from '../public/runtime/names.js';
import { lowerModules } from '../public/runtime/esm-lite.js';
import { parseTarget as resolveTarget, qualify, scriptContext, NameError } from '../public/runtime/modules.js';
import { sandboxConsole } from './console-log.js';
import { sql } from './sql.js';

// Compiled scripts are cached by modification time, so saving a file in the designer is
// picked up on the next call with no restart.
const compiled = new Map();

const MAX_DEPTH = 32;

// What a script may learn about where it runs: the Node version (no leading "v"), the OS and
// CPU family, and the platform's own version. Read once and frozen - none of it changes while
// the server runs - and deliberately no more: paths, environment and memory stay out of scripts.
const runtimeInfo = Object.freeze({
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  runtime: createRequire(import.meta.url)('../package.json').version
});

export class ScriptError extends Error {
  constructor(message, status = 500, detail) {
    super(message);
    this.name = 'ScriptError';
    this.status = status;
    this.detail = detail;
  }
}

// A NameError from the shared resolver is a bad request, reported like a store error.
function named(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof NameError) throw new StoreError(err.message);
    throw err;
  }
}

// A target is "Module.script.fn" - or "script.fn" from inside a script, which takes that
// script's module: a server script is a library of top-level functions, and a call names
// exactly one of them. The result is a script id - what to load and how to name it - plus the
// function's name.
export function parseTarget(target, module) {
  const parsed = named(() => resolveTarget(target, module));
  return { name: parsed.qualified, module: parsed.module, script: scriptId(parsed.qualified), member: parsed.member, target: parsed.target };
}

// The wrapper runs the script's top-level statements once and hands its declarations back, so
// that a call can pick the function it names.
// `require`, `callFunction` and `runBackground` are handed in per script, bound to its module:
// a bare name in any of them reaches this script's own module. (The session's globals of the
// same names stay for workflow expressions, where a target always carries its module.)
// `context` says where the script lives: its kind, module and names.
function wrap(source) {
  const tail = scanTopLevelNames(source)
    .map((n) => `try { __exports[${JSON.stringify(n)}] = ${n}; } catch (e) {}`)
    .join('\n');
  return `(async function (__exports, require, callFunction, runBackground, context) {\n${source}\n;{\n${tail}\n}\n})`;
}

// A compiled script plus the names it requires. import/export syntax is lowered onto require()
// first - the export keyword adds nothing, since every top-level function is callable already.
async function loadScript({ key, file, filename, missing }) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (err) {
    if (err.code === 'ENOENT') throw new ScriptError(missing, 404);
    throw err;
  }

  const cached = compiled.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const raw = await fs.readFile(file, 'utf8');
  let entry;
  try {
    const source = lowerModules(raw, { exports: false }).code;
    // lineOffset cancels the line the wrapper adds, so stack traces point at the real source.
    entry = { mtimeMs: stat.mtimeMs, script: new vm.Script(wrap(source), { filename, lineOffset: -1 }), requires: scanRequires(source) };
  } catch (err) {
    throw new ScriptError(`${filename} failed to compile: ${err.message}`, 500, err.stack);
  }
  compiled.set(key, entry);
  return entry;
}

function scriptId(name) {
  assertQualified(name);
  const module = name.split('.')[0];
  return { key: name, module, file: codePath('server-scripts', name), filename: `server-scripts/${name}.js`, label: 'the server script', missing: `Server script "${name}" does not exist.` };
}

// The built-ins that reach into the workflow engine and the job runs registry. Imported when
// first called rather than at the top of the file: the engine and the registry both call back
// into callServer, and a static import both ways would be a cycle. A worker thread swaps these
// for message round-trips with setServices, since the engine and the registry live on the main
// thread only.
export const defaultServices = {
  startWorkflow: async (name, args, options) => {
    const { startWorkflow } = await import('./workflow/index.js');
    const instance = await startWorkflow(name, args, options);
    return { id: instance.id, status: instance.status };
  },
  signalWorkflow: async (id, name, payload) => {
    const { signalWorkflow } = await import('./workflow/index.js');
    return signalWorkflow(id, name, payload);
  },
  cancelWorkflow: async (id, reason) => {
    const { cancelWorkflow } = await import('./workflow/index.js');
    const instance = await cancelWorkflow(id, reason);
    return instance ? { id: instance.id, status: instance.status } : null;
  },
  // The whole instance - variables and log included - because that is what a script wants to
  // show. The list below returns summaries.
  getWorkflowInstance: async (id) => {
    const { instances } = await import('./workflow/index.js');
    return (await instances.read(id)) || null;
  },
  // So an application can find the instance it needs to signal.
  listWorkflowInstances: async (query) => {
    const { instances } = await import('./workflow/index.js');
    return instances.list(query || {});
  },
  // Background job runs: detached from the request, monitored in the Jobs panel.
  // runBackground(target, args, { at, delay }) defers the run to a moment or by a duration.
  runBackground: async (target, args, options) => {
    const { runs } = await import('./jobs/index.js');
    const { at, delay } = options || {};
    return runs.start(target, args, { at, delay });
  },
  getJob: async (id) => {
    const { runs } = await import('./jobs/index.js');
    return (await runs.read(id)) || null;
  },
  cancelJob: async (id) => {
    const { runs } = await import('./jobs/index.js');
    return runs.cancel(id);
  },
  listJobs: async (query) => {
    const { runs } = await import('./jobs/index.js');
    return runs.list(query || {});
  },
  // A secret's value (secrets.js), opened on the main thread only: a worker thread asks over
  // its message channel, so the project's key is never read there.
  getSecret: async (name) => {
    const { readSecret } = await import('./secrets.js');
    return readSecret(name);
  }
};

export const SERVICE_NAMES = Object.keys(defaultServices);

let services = defaultServices;

export function setServices(impl) {
  services = impl;
}

// One context per request. Scripts pulled in through callFunction share it, so a request behaves
// like a single program, while separate requests never see each other's globals. `extras` are
// caller-supplied globals for special sessions - a background run gets its `job` handle this way.
function createSession(extras, origin = null) {
  const session = { depth: 0, modules: new Map() };

  const sandbox = {
    // What the script prints is kept for the designer's Console tab as well as written out.
    console: sandboxConsole(origin),
    JSON,
    Math,
    Date,
    Promise,
    Error,
    TypeError,
    RangeError,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    queueMicrotask,
    structuredClone,
    callFunction: (target, args) => invoke(session, target, args),
    // Plain values, not a service: a worker thread answers it itself, with no round-trip.
    getRuntimeInfo: () => runtimeInfo,
    ...services,
    // The application database. dbQuery returns rows; dbRun returns { changes,
    // lastInsertRowid }. Values bind as parameters - never build SQL out of user input. Both
    // take a string with its params, or a sql`...` statement, whose ${values} bind the same way.
    sql,
    dbQuery: async (sql, params) => {
      const { query } = await import('./db.js');
      return query(sql, params);
    },
    dbRun: async (sql, params) => {
      const { execute } = await import('./db.js');
      return execute(sql, params);
    },
    // The project's file store, a small async file system under data_runtime/files; the same
    // object on a worker thread, since it is only the disk.
    files: filesService
  };
  Object.assign(sandbox, extras);
  sandbox.globalThis = sandbox;

  session.context = vm.createContext(sandbox, { name: 'appmaker-server-scripts' });
  return session;
}

// Evaluates a script once per session: the scripts it requires first (so its require() can
// answer synchronously, the way a code behind's does), then its own top-level code. The exports
// object is registered before anything runs, so two scripts that require each other get each
// other's partial module rather than an endless loop.
async function instantiate(session, id) {
  if (session.modules.has(id.key)) return session.modules.get(id.key);
  const { script, requires } = await loadScript(id);
  const exports = Object.create(null);
  session.modules.set(id.key, exports);

  if (session.depth >= MAX_DEPTH) {
    throw new ScriptError(`Server script call depth exceeded ${MAX_DEPTH} while loading "${id.key}". Check for a cycle.`, 508);
  }
  session.depth += 1;
  try {
    for (const name of requires) await instantiate(session, scriptId(named(() => qualify(name, id.module))));
  } finally {
    session.depth -= 1;
  }

  const require = (name) => {
    const found = typeof name === 'string' && session.modules.get(named(() => qualify(name, id.module)));
    if (!found) {
      throw new ScriptError(`require(${JSON.stringify(name)}) needs a plain string naming a server script, and ${JSON.stringify(name)} was not preloaded.`, 400);
    }
    return found;
  };
  const callFunction = (target, args) => invoke(session, target, args, id.module);
  const runBackground = (target, args, options) => services.runBackground(named(() => resolveTarget(target, id.module)).target, args, options);
  const factory = script.runInContext(session.context);
  await factory(exports, require, callFunction, runBackground, scriptContext('server-script', id.key));
  return exports;
}

// `module` is the calling script's, when there is one: it completes a "script.fn" target.
async function invoke(session, target, args, module) {
  const { script, member } = parseTarget(target, module);
  const callArgs = Array.isArray(args) ? args : args === undefined ? [] : [args];

  if (session.depth >= MAX_DEPTH) {
    throw new ScriptError(`Server script call depth exceeded ${MAX_DEPTH} while running "${target}". Check for a cycle.`, 508);
  }
  session.depth += 1;
  try {
    const exports = await instantiate(session, script);
    const fn = exports[member];
    // A class is a function too, but not a callable one: only plain top-level functions answer.
    if (typeof fn !== 'function' || /^class\b/.test(Function.prototype.toString.call(fn))) {
      throw new ScriptError(`"${target}" is not a function of ${script.label} (a top-level function named "${member}").`, 404);
    }
    return await fn(...callArgs);
  } finally {
    session.depth -= 1;
  }
}

// Entry point used by the HTTP layer for callServer(...). `extras` become globals of the session.
export async function callServer(target, args, extras) {
  // A background run prints under its job id, anything else under the function it was called for.
  const origin = extras && extras.job && extras.job.id ? extras.job.id : target;
  return invoke(createSession(extras, origin), target, args);
}

export function clearCache() {
  compiled.clear();
}
