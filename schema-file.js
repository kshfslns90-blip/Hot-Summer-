// The schema file, data/db/schema.json: the tables a project designed, with their seed rows,
// and the users seed. Read and written here by path, with no database in sight, so that a
// process serving many projects (the preview host) can read any project's schema without
// opening any project's database. The database module wraps these for this process's own.
import fs from 'node:fs';
import path from 'node:path';
import { StoreError, insideFileSync } from './store.js';
import { SECRET_NAME_RE, SECRET_NAME_MAX } from './secret-names.js';

// `root`, when given, is the project folder the file must really be inside (see the store).
export function readSchemaFile(file, { root } = {}) {
  if (root) insideFileSync(root, file);
  try {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(schema.tables)) schema.tables = [];
    return schema;
  } catch (err) {
    if (err.code === 'ENOENT') return { tables: [] };
    throw new StoreError(`The schema file is not valid JSON: ${err.message}`, 500);
  }
}

export function writeSchemaFile(file, schema, { root } = {}) {
  if (root) insideFileSync(root, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
}

// The secrets a project defines: `secrets: [{ name, description }]` beside the tables - names
// and what they are for, never values (those are in the runtime database, see secrets.js). A
// name is an identifier, unique whatever its case (secret-names.js).
export { SECRET_NAME_RE, SECRET_NAME_MAX, SECRET_DESCRIPTION_MAX } from './secret-names.js';

// The usable entries, in the file's order, and a warning for each one left out. Read by path
// like the rest, so a hand edit, an import or a restore counts at the next call.
export function secretsOf(schema) {
  const secrets = [];
  const warnings = [];
  const list = schema ? schema.secrets : undefined;
  if (list === undefined) return { secrets, warnings };
  if (!Array.isArray(list)) return { secrets, warnings: ['the schema file\'s "secrets" is not a list; no secret is defined'] };
  const seen = new Set();
  for (const entry of list) {
    const name = entry && typeof entry.name === 'string' ? entry.name : '';
    if (!SECRET_NAME_RE.test(name) || name.length > SECRET_NAME_MAX) {
      warnings.push(`secret ${JSON.stringify(entry && entry.name !== undefined ? entry.name : entry)} skipped: a name is letters, digits and underscores, starting with a letter, at most ${SECRET_NAME_MAX} characters`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      warnings.push(`secret "${name}" skipped: another secret has that name`);
      continue;
    }
    seen.add(name.toLowerCase());
    secrets.push({ name, description: typeof entry.description === 'string' ? entry.description : '' });
  }
  return { secrets, warnings };
}

// Replaces (or, with null, removes) one table's entry, leaving the rest as they are. The users
// seed lives in the schema file this way: an entry with a seed and no columns.
export function writeSchemaEntryIn(file, name, entry, options = {}) {
  const schema = readSchemaFile(file, options);
  const at = schema.tables.findIndex((t) => t.name === name);
  if (entry === null) {
    if (at >= 0) schema.tables.splice(at, 1);
  } else if (at >= 0) schema.tables[at] = entry;
  else schema.tables.push(entry);
  writeSchemaFile(file, schema, options);
}
