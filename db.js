// The application database, in two halves:
//
//   - data/db/schema.json     the SOURCE - the tables you designed, versioned with the app;
//   - data_runtime/db/app.db  the MATERIALISATION - live SQLite state, never committed.
//
// Structure edits made in the designer apply to the database and the schema file in the same
// breath, so the two agree in development. On boot, reconcile() brings a fresh (or stale)
// database up to the schema ADDITIVELY ONLY: missing tables are created, missing columns are
// added, and nothing is ever dropped or retyped automatically - drift in the destructive
// direction is reported, not acted on. Tables created outside the designer are left alone and
// simply show as unmanaged; touching one in the designer adopts it into the schema.
//
// Server scripts reach the data through dbQuery/dbRun; the Data node uses the functions
// below via /designer/api/db.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { StoreError, setAuthEnabledHook } from './store.js';
import { readSchemaFile, writeSchemaFile, writeSchemaEntryIn, secretsOf } from './schema-file.js';
import { SYSTEM_TABLES, AUTH_TABLE_NAMES, isSystemTable, MASKED_COLUMNS, MASK } from './system-tables.js';
import { SqlStatement } from './sql.js';

// Table and column names cannot be bound as parameters, so they are validated as identifiers
// and double-quoted - the same defence the artifact store uses for file names.
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// SQLite keeps whatever type name a column was declared with, so friendlier names round-trip.
export const COLUMN_TYPES = ['TEXT', 'INTEGER', 'REAL', 'BOOLEAN', 'DATETIME', 'NUMERIC', 'BLOB'];
const RAW_DEFAULTS = new Set(['CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME']);

// Foreign key actions: schema spelling <-> SQL.
export const ON_DELETE = { noAction: 'NO ACTION', cascade: 'CASCADE', setNull: 'SET NULL', restrict: 'RESTRICT' };
const ON_DELETE_FROM_SQL = { 'NO ACTION': 'noAction', CASCADE: 'cascade', 'SET NULL': 'setNull', RESTRICT: 'restrict' };

let db = null;

export function connection() {
  if (!db) {
    fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
    db = new DatabaseSync(config.dbFile);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
  }
  return db;
}

// For tests: drop the handle so the next call reopens against the current config.
export function close() {
  if (db) {
    db.close();
    db = null;
  }
}

export function assertIdent(name, what = 'name') {
  if (typeof name !== 'string' || !IDENT_RE.test(name)) {
    throw new StoreError(`Invalid ${what} "${name}". Use letters, digits and underscore, starting with a letter or underscore.`);
  }
  return name;
}

function quote(name) {
  return `"${assertIdent(name)}"`;
}

// A DEFAULT clause cannot be parameterised; only plain literals are accepted from the designer.
function literal(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value);
  if (/^-?\d+(\.\d+)?$/.test(text)) return text;
  return `'${text.replace(/'/g, "''")}'`;
}

// A default typed by a person -> the SQL literal for the DDL. The few SQLite keywords that make
// sense as defaults pass through as expressions.
function defaultLiteral(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (RAW_DEFAULTS.has(text.toUpperCase())) return text.toUpperCase();
  return literal(text);
}

// The reverse, for editing: 'abc' -> abc, 0 -> 0, CURRENT_TIMESTAMP -> as is.
export function unquoteDefault(sqlLiteral) {
  if (sqlLiteral === null || sqlLiteral === undefined) return '';
  const text = String(sqlLiteral);
  const quoted = /^'([\s\S]*)'$/.exec(text);
  return quoted ? quoted[1].replace(/''/g, "'") : text;
}

function run(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof StoreError) throw err;
    // SQLite's message is the useful part; the stack into node:sqlite is not.
    throw new StoreError(err.message, 400);
  }
}

function bindArgs(params) {
  if (params === undefined || params === null) return [];
  return Array.isArray(params) ? params : [params];
}

// What dbQuery and dbRun are handed -> the text to prepare and the values to bind: a string with
// its params, or a sql`...` statement, which carries its own values.
function statementOf(sql, params, name) {
  if (sql instanceof SqlStatement) {
    if (params !== undefined && params !== null) throw new StoreError(`${name}: a sql\`...\` statement carries its own values; pass no params.`);
    if (!sql.text.trim()) throw new StoreError(`${name} needs a SQL string or a sql\`...\` statement.`);
    return { text: sql.text, args: sql.values };
  }
  if (typeof sql !== 'string' || !sql.trim()) throw new StoreError(`${name} needs a SQL string or a sql\`...\` statement.`);
  return { text: sql, args: bindArgs(params) };
}

// dbQuery('select * from orders where total > ?', [100]), or
// dbQuery(sql`select * from orders where total > ${100}`) - rows back.
export function query(sql, params) {
  const { text, args } = statementOf(sql, params, 'dbQuery');
  return run(() => connection().prepare(text).all(...args));
}

// The Data tab's SQL box: any statement, typed by hand. A statement that returns columns is a
// read - the first 500 rows come back with the column names (so an empty result still has its
// headers); anything else runs as a script through exec (several statements are fine) and
// reports how many rows changed.
export const SQL_ROW_CAP = 500;
// The SQL box is a developer's tool, but the system tables' structure is off limits there too;
// the check is by pattern and best effort.
const SYSTEM_DDL = /\b(?:drop|alter)\s+table\s+(?:if\s+exists\s+)?["`\[]?(users|sessions|api_keys|secret_values)["`\]]?\b/i;

export function runSql(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new StoreError('Type a SQL statement first.');
  const ddl = SYSTEM_DDL.exec(sql);
  if (ddl) assertNotSystem(ddl[1], 'drop or alter');
  return run(() => {
    const db = connection();
    const started = performance.now();
    const statement = db.prepare(sql);
    const columns = statement.columns().map((c) => c.name);
    if (columns.length > 0) {
      const all = statement.all();
      const list = all.slice(0, SQL_ROW_CAP);
      // A hash column reads as masked whatever table the query joined it from.
      const secret = new Set(Object.values(MASKED_COLUMNS).flatMap((set) => [...set]));
      for (const row of list) {
        for (const key of Object.keys(row)) {
          if (row[key] instanceof Uint8Array) row[key] = `[blob ${row[key].byteLength} bytes]`;
          else if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
          if (secret.has(key) && row[key] !== null && row[key] !== undefined) row[key] = MASK;
        }
      }
      return { kind: 'rows', columns, rows: list, truncated: all.length > SQL_ROW_CAP, ms: Math.round(performance.now() - started) };
    }
    const before = Number(db.prepare('SELECT total_changes() AS n').get().n);
    db.exec(sql);
    const after = Number(db.prepare('SELECT total_changes() AS n').get().n);
    return { kind: 'changes', changes: after - before, ms: Math.round(performance.now() - started) };
  });
}

// dbRun('insert into orders (title) values (?)', ['x']), or
// dbRun(sql`insert into orders (title) values (${'x'})`) - { changes, lastInsertRowid }.
export function execute(sql, params) {
  const { text, args } = statementOf(sql, params, 'dbRun');
  return run(() => {
    const result = connection().prepare(text).run(...args);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  });
}

// --- the schema file --------------------------------------------------------

// This process's own schema file (config.dbSchemaFile); the reading and writing live in
// schema-file.js, by path, so the preview host can read any project's without this module.
export function readSchema() {
  return readSchemaFile(config.dbSchemaFile);
}

function writeSchema(schema) {
  writeSchemaFile(config.dbSchemaFile, schema);
}

// Replaces (or, with null, removes) one table's entry, leaving the rest as they are. The users
// seed lives in the schema file this way: an entry with a seed and no columns.
export function writeSchemaEntry(name, entry) {
  writeSchemaEntryIn(config.dbSchemaFile, name, entry);
}

// The secrets the project defines (secrets.js): the list kept beside the tables, written back
// whole; an empty list leaves the file without the key, as it was before any secret.
export function writeSchemaSecrets(list) {
  const schema = readSchema();
  if (list.length) schema.secrets = list;
  else delete schema.secrets;
  writeSchema(schema);
}

// The live table, in the shape the schema file stores: dflt is the SQL literal exactly as
// SQLite reports it, false/null fields are omitted, single-column foreign keys ride on their
// column as `references`, and the table's own (non-automatic) indexes come along.
function capture(name) {
  const db = connection();
  const columns = db
    .prepare(`PRAGMA table_info(${quote(name)})`)
    .all()
    .map((c) => ({
      name: c.name,
      type: c.type || 'TEXT',
      ...(c.notnull ? { notnull: true } : {}),
      ...(c.dflt_value !== null && c.dflt_value !== undefined ? { dflt: c.dflt_value } : {}),
      ...(c.pk ? { pk: true } : {})
    }));

  const keys = new Map();
  for (const fk of db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()) {
    if (!keys.has(fk.id)) keys.set(fk.id, []);
    keys.get(fk.id).push(fk);
  }
  for (const parts of keys.values()) {
    if (parts.length !== 1) continue; // composite keys are out of scope for the designer
    const fk = parts[0];
    const column = columns.find((c) => c.name === fk.from);
    if (!column) continue;
    column.references = {
      table: fk.table,
      column: fk.to || parentKeyColumn(fk.table),
      onDelete: ON_DELETE_FROM_SQL[String(fk.on_delete || 'NO ACTION').toUpperCase()] || 'noAction'
    };
  }

  const indexes = [];
  // index_list reports newest first; creation order reads better and is what the schema keeps.
  for (const ix of db.prepare(`PRAGMA index_list(${quote(name)})`).all().sort((a, b) => b.seq - a.seq)) {
    if (ix.origin !== 'c' || ix.partial) continue; // only CREATE INDEX ones; pk/unique constraints are implicit
    const cols = db.prepare(`PRAGMA index_info(${quote(ix.name)})`).all().sort((a, b) => a.seqno - b.seqno).map((i) => i.name);
    if (cols.some((c) => c === null)) continue; // expression indexes are out of scope
    indexes.push({ name: ix.name, columns: cols, ...(ix.unique ? { unique: true } : {}) });
  }
  return { name, columns, ...(indexes.length ? { indexes } : {}) };
}

function parentKeyColumn(table) {
  try {
    const pk = connection().prepare(`PRAGMA table_info(${quote(table)})`).all().find((c) => c.pk);
    return pk ? pk.name : 'id';
  } catch {
    return 'id';
  }
}

// Who points at this table: [{ table, column }] over every other live table.
function referencedBy(name) {
  const out = [];
  for (const other of listTables()) {
    if (other === name) continue;
    for (const column of capture(other).columns) {
      if (column.references && column.references.table === name) out.push({ table: other, column: column.name, parentColumn: column.references.column });
    }
  }
  return out;
}

// Columns a foreign key may point at: the primary key, or any column with a unique index.
function keyColumns(table) {
  const info = capture(table);
  const keys = info.columns.filter((c) => c.pk).map((c) => c.name);
  for (const ix of info.indexes || []) if (ix.unique && ix.columns.length === 1) keys.push(ix.columns[0]);
  for (const ix of connection().prepare(`PRAGMA index_list(${quote(table)})`).all()) {
    if (ix.origin === 'u' && ix.unique) {
      const cols = connection().prepare(`PRAGMA index_info(${quote(ix.name)})`).all();
      if (cols.length === 1) keys.push(cols[0].name);
    }
  }
  return [...new Set(keys)];
}

// Every designer mutation ends here: whatever the table now looks like is what the schema says.
// The seed is authored rather than captured, so it is carried across the rewrite - keys follow a
// column rename and keys for columns that no longer exist are dropped.
function recordTable(name, { removed = null, mapColumn = null, renames = null } = {}) {
  // System tables are defined in code, never in the schema file.
  if (isSystemTable(name) || isSystemTable(removed)) return;
  const schema = readSchema();
  const prior = schema.tables.find((t) => t.name === (removed || name));
  if (removed) schema.tables = schema.tables.filter((t) => t.name !== removed);
  if (name) {
    const entry = capture(name);
    if (prior?.seed?.length) {
      const valid = new Set(entry.columns.map((c) => c.name));
      const renamed = new Map(renames || (mapColumn ? [mapColumn] : []));
      entry.seed = prior.seed.map((row) => {
        const next = {};
        for (const [key, value] of Object.entries(row)) {
          const target = renamed.has(key) ? renamed.get(key) : key;
          if (valid.has(target)) next[target] = value;
        }
        return next;
      });
    }
    const at = schema.tables.findIndex((t) => t.name === name);
    if (at === -1) schema.tables.push(entry);
    else schema.tables[at] = entry;
  }
  writeSchema(schema);
}

// --- schema operations for the Data node ------------------------------------

export function listTables() {
  return run(() =>
    connection()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all()
      .map((row) => row.name)
  );
}

function assertTable(name) {
  assertIdent(name, 'table name');
  if (!listTables().includes(name)) throw new StoreError(`Table "${name}" does not exist.`, 404);
  return name;
}

// The tables authentication owns are managed by AppMaker: their structure is not the
// designer's to change, whichever page or endpoint asks.
function assertNotSystem(name, what = 'change') {
  if (isSystemTable(name)) throw new StoreError(`"${name}" is a system table; AppMaker manages its structure, so you cannot ${what} it.`, 403);
}

// Values that must never leave the server in the clear.
function maskRow(table, row) {
  const masked = MASKED_COLUMNS[table];
  if (!masked) return row;
  for (const key of Object.keys(row)) if (masked.has(key) && row[key] !== null && row[key] !== undefined) row[key] = MASK;
  return row;
}

export function tableInfo(name) {
  assertTable(name);
  return run(() => {
    const live = capture(name);
    const { count } = connection().prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get();
    const entry = readSchema().tables.find((t) => t.name === name);
    return {
      name,
      columns: live.columns.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: Boolean(c.notnull),
        dflt: c.dflt ?? null,
        dfltValue: unquoteDefault(c.dflt ?? null),
        pk: Boolean(c.pk),
        references: c.references || null
      })),
      indexes: (live.indexes || []).map((ix) => ({ name: ix.name, columns: [...ix.columns], unique: Boolean(ix.unique) })),
      referencedBy: referencedBy(name),
      rowCount: Number(count),
      system: isSystemTable(name),
      managed: Boolean(entry) || isSystemTable(name),
      // A system table's seed is shown with its hashes masked; it is edited elsewhere.
      seed: Array.isArray(entry?.seed) ? (isSystemTable(name) ? entry.seed.map((row) => maskRow(name, { ...row })) : entry.seed) : [],
      seedInSync: isSystemTable(name) ? false : seedInSync(name, entry?.seed)
    };
  });
}

// Foreign key targets the designer can offer: every other table's key columns.
export function linkTargets() {
  return run(() => listTables().map((table) => ({ table, columns: keyColumns(table) })));
}

// A new table starts with a rowid-backed id, so it is valid from the first moment; columns come
// after, from the Structure page.
export function createTable(name) {
  assertIdent(name, 'table name');
  if (isSystemTable(name)) throw new StoreError(`"${name}" is reserved for AppMaker's own ${name} table; turn authentication on to create it.`, 409);
  if (listTables().includes(name)) throw new StoreError(`Table "${name}" already exists.`, 409);
  run(() => connection().exec(`CREATE TABLE ${quote(name)} (id INTEGER PRIMARY KEY AUTOINCREMENT)`));
  recordTable(name);
  return tableInfo(name);
}

export function dropTable(name) {
  assertTable(name);
  assertNotSystem(name, 'drop');
  const users = referencedBy(name);
  if (users.length > 0) {
    throw new StoreError(`Table "${name}" is referenced by ${users.map((u) => `${u.table}.${u.column}`).join(', ')}; remove that link first.`);
  }
  run(() => connection().exec(`DROP TABLE ${quote(name)}`));
  recordTable(null, { removed: name });
  return { name, dropped: true };
}

export function renameTable(name, newName) {
  assertTable(name);
  assertNotSystem(name, 'rename');
  assertIdent(newName, 'table name');
  if (listTables().includes(newName)) throw new StoreError(`Table "${newName}" already exists.`, 409);
  run(() => connection().exec(`ALTER TABLE ${quote(name)} RENAME TO ${quote(newName)}`));
  recordTable(newName, { removed: name });
  return tableInfo(newName);
}

export function addColumn(table, { name, type, notnull, dflt } = {}) {
  assertTable(table);
  assertNotSystem(table, 'add a column to');
  assertIdent(name, 'column name');
  const columnType = COLUMN_TYPES.includes(String(type).toUpperCase()) ? String(type).toUpperCase() : 'TEXT';
  const dfltLiteral = literal(dflt);
  let ddl = `ALTER TABLE ${quote(table)} ADD COLUMN ${quote(name)} ${columnType}`;
  if (dfltLiteral !== null) ddl += ` DEFAULT ${dfltLiteral}`;
  // SQLite refuses NOT NULL without a default on a table that already has rows.
  if (notnull) ddl += ' NOT NULL';
  run(() => connection().exec(ddl));
  recordTable(table);
  return tableInfo(table);
}

export function dropColumn(table, column) {
  assertTable(table);
  assertNotSystem(table, 'drop a column of');
  assertIdent(column, 'column name');
  run(() => connection().exec(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)}`));
  recordTable(table);
  return tableInfo(table);
}

export function renameColumn(table, column, newName) {
  assertTable(table);
  assertNotSystem(table, 'rename a column of');
  assertIdent(column, 'column name');
  assertIdent(newName, 'column name');
  run(() => connection().exec(`ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(column)} TO ${quote(newName)}`));
  recordTable(table, { mapColumn: [column, newName] });
  return tableInfo(table);
}

// A foreign key as the designer sends it -> validated schema shape, or null.
function normaliseReference(ref, table, columnName) {
  if (!ref || typeof ref !== 'object' || !ref.table) return null;
  const parent = String(ref.table);
  assertIdent(parent, 'table name');
  if (!listTables().includes(parent)) throw new StoreError(`${table}.${columnName}: table "${parent}" does not exist.`);
  const column = String(ref.column || parentKeyColumn(parent));
  assertIdent(column, 'column name');
  const keys = parent === table ? capture(table).columns.filter((c) => c.pk).map((c) => c.name) : keyColumns(parent);
  if (!keys.includes(column)) {
    throw new StoreError(`${table}.${columnName}: "${parent}.${column}" must be a primary key or have a unique index to be linked to.`);
  }
  const onDelete = ref.onDelete && ON_DELETE[ref.onDelete] ? ref.onDelete : 'noAction';
  return { table: parent, column, onDelete };
}

function sameReference(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.table === b.table && a.column === b.column && (a.onDelete || 'noAction') === (b.onDelete || 'noAction');
}

function indexDdl(table, index) {
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(table)} (${index.columns.map(quote).join(', ')})`;
}

// Indexes the designer sends -> validated { name, columns, unique } over the new column names.
function normaliseIndexes(table, indexesIn, columnNames) {
  if (indexesIn === undefined) return null; // caller does not manage indexes
  if (!Array.isArray(indexesIn)) throw new StoreError('Indexes must be a list.');
  const names = new Set();
  const own = new Set((capture(table).indexes || []).map((ix) => ix.name));
  const taken = new Set(
    connection().prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all().map((r) => r.name).filter((n) => !own.has(n))
  );
  return indexesIn.map((ix) => {
    const name = assertIdent(String(ix.name || '').trim(), 'index name');
    if (names.has(name)) throw new StoreError(`Index "${name}" appears twice.`);
    if (taken.has(name)) throw new StoreError(`Index name "${name}" is already used elsewhere in the database.`);
    names.add(name);
    const columns = Array.isArray(ix.columns) ? ix.columns.map((c) => String(c)) : [];
    if (columns.length === 0) throw new StoreError(`Index "${name}" needs at least one column.`);
    for (const c of columns) if (!columnNames.has(c)) throw new StoreError(`Index "${name}" uses a column that is not in the table: "${c}".`);
    if (new Set(columns).size !== columns.length) throw new StoreError(`Index "${name}" lists a column twice.`);
    return { name, columns, unique: Boolean(ix.unique) };
  });
}

// Bring the table's CREATE INDEX set to `wanted`: drop what is not wanted or has changed,
// create what is missing. Only indexes made with CREATE INDEX are touched.
function syncIndexes(table, wanted) {
  const db = connection();
  const live = capture(table).indexes || [];
  const same = (a, b) => a.columns.join('\n') === b.columns.join('\n') && Boolean(a.unique) === Boolean(b.unique);
  for (const ix of live) {
    const target = wanted.find((w) => w.name === ix.name);
    if (!target || !same(target, ix)) db.exec(`DROP INDEX IF EXISTS ${quote(ix.name)}`);
  }
  for (const ix of wanted) db.exec(indexDdl(table, ix));
}

// The whole structure at once, from the Structure editor's Apply: `columns` in their wanted
// order - each with `from` (its current name, null when new), name, type, notnull, dflt (plain
// value), pk and an optional `references` - and `indexes`. Additive column changes use ALTER;
// anything else rebuilds the table, keeping the data. Indexes always sync in place.
export function replaceStructure(table, spec) {
  assertTable(table);
  assertNotSystem(table, 'restructure');
  const columnsIn = Array.isArray(spec) ? spec : spec && spec.columns;
  const indexesIn = Array.isArray(spec) ? undefined : spec && spec.indexes;
  if (!Array.isArray(columnsIn) || columnsIn.length === 0) throw new StoreError('A table needs at least one column.');
  const current = capture(table).columns;
  const currentNames = new Set(current.map((c) => c.name));
  const seen = new Set();
  const columns = columnsIn.map((c) => {
    const name = assertIdent(String(c.name || '').trim(), 'column name');
    if (seen.has(name)) throw new StoreError(`Column "${name}" appears twice.`);
    seen.add(name);
    const typeText = String(c.type || 'TEXT').trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_ ()]*$/.test(typeText)) throw new StoreError(`"${c.type}" is not a column type.`);
    return {
      from: c.from && currentNames.has(c.from) ? c.from : null,
      name,
      type: typeText,
      notnull: Boolean(c.notnull),
      dflt: defaultLiteral(c.dflt),
      pk: Boolean(c.pk),
      references: normaliseReference(c.references, table, name)
    };
  });
  if (columns.filter((c) => c.pk).length > 1) throw new StoreError('Only one column can be the primary key.');
  const froms = columns.filter((c) => c.from).map((c) => c.from);
  if (new Set(froms).size !== froms.length) throw new StoreError('A column can only be kept once.');
  const indexes = normaliseIndexes(table, indexesIn, new Set(columns.map((c) => c.name)));

  const kept = columns.filter((c) => c.from);
  const byName = new Map(current.map((c) => [c.name, c]));
  const dropped = current.filter((c) => !kept.some((k) => k.from === c.name));
  const renames = kept.filter((k) => k.from !== k.name).map((k) => [k.from, k.name]);

  // Columns other tables point at stay put: dropping or renaming one would strand their keys.
  for (const user of referencedBy(table)) {
    const gone = dropped.find((c) => c.name === user.parentColumn);
    const renamed = renames.find(([from]) => from === user.parentColumn);
    if (gone || renamed) {
      throw new StoreError(`Column "${user.parentColumn}" is used by ${user.table}.${user.column}; remove that link first.`);
    }
  }

  // ALTER can only append, drop, and rename - and cannot touch a primary key or a foreign key.
  const keptOrder = current.map((c) => c.name).filter((n) => kept.some((k) => k.from === n));
  const sameOrder = kept.map((k) => k.from).join('\n') === keptOrder.join('\n');
  const untouched = kept.every((k) => {
    const old = byName.get(k.from);
    return (old.type || 'TEXT').toUpperCase() === k.type && Boolean(old.notnull) === k.notnull &&
      (old.dflt ?? null) === k.dflt && Boolean(old.pk) === k.pk && sameReference(old.references, k.references);
  });
  const lastKept = columns.map((c) => Boolean(c.from)).lastIndexOf(true);
  const firstNew = columns.findIndex((c) => !c.from);
  const appended = firstNew === -1 || firstNew > lastKept;
  const newPk = columns.some((c) => !c.from && c.pk);
  const newLink = columns.some((c) => !c.from && c.references);
  const dropsPk = dropped.some((c) => c.pk);
  const additive = sameOrder && untouched && appended && !newPk && !newLink && !dropsPk;

  run(() => {
    const db = connection();
    if (additive) {
      db.exec('BEGIN');
      try {
        for (const old of dropped) db.exec(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(old.name)}`);
        for (const [from, to] of renames) db.exec(`ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(from)} TO ${quote(to)}`);
        for (const c of columns) if (!c.from) db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${columnDdl(c)}`);
        if (indexes) syncIndexes(table, indexes);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return;
    }
    rebuildTable(table, columns, indexes || (capture(table).indexes || []).map((ix) => ({ ...ix, columns: ix.columns.map((c) => (renames.find(([f]) => f === c) || [c, c])[1]) })));
  });
  recordTable(table, { renames });
  return tableInfo(table);
}

// SQLite's copy-and-swap: a new table with the wanted definition, the kept columns copied over
// under their new names, then the swap, then the indexes (they die with the old table) - all
// or nothing.
function rebuildTable(table, columns, indexes = []) {
  const db = connection();
  const tmp = `__tmp_${table}`;
  const pks = columns.filter((c) => c.pk);
  const parts = columns.map((c) => columnDdl(c, { inlinePk: pks.length === 1 }));
  if (pks.length > 1) parts.push(`PRIMARY KEY (${pks.map((c) => quote(c.name)).join(', ')})`);
  const kept = columns.filter((c) => c.from);
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`DROP TABLE IF EXISTS ${quote(tmp)}`);
    db.exec(`CREATE TABLE ${quote(tmp)} (${parts.join(', ')})`);
    if (kept.length > 0) {
      db.exec(
        `INSERT INTO ${quote(tmp)} (${kept.map((c) => quote(c.name)).join(', ')}) ` +
          `SELECT ${kept.map((c) => quote(c.from)).join(', ')} FROM ${quote(table)}`
      );
    }
    db.exec(`DROP TABLE ${quote(table)}`);
    db.exec(`ALTER TABLE ${quote(tmp)} RENAME TO ${quote(table)}`);
    const names = new Set(columns.map((c) => c.name));
    for (const ix of indexes) {
      if (ix.columns.every((c) => names.has(c))) db.exec(indexDdl(table, ix));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// The Data page: a window of rows plus the total, with values made JSON-friendly.
export function rows(table, { limit = 100, offset = 0 } = {}) {
  assertTable(table);
  const window = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const skip = Math.max(Number(offset) || 0, 0);
  return run(() => {
    const list = connection().prepare(`SELECT * FROM ${quote(table)} LIMIT ? OFFSET ?`).all(window, skip);
    const { count } = connection().prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get();
    for (const row of list) {
      for (const key of Object.keys(row)) {
        if (row[key] instanceof Uint8Array) row[key] = `[blob ${row[key].byteLength} bytes]`;
        else if (typeof row[key] === 'bigint') row[key] = Number(row[key]);
      }
      maskRow(table, row);
    }
    return { rows: list, total: Number(count), limit: window, offset: skip };
  });
}

// --- seeds ------------------------------------------------------------------

// A seed is reference/demo data small enough to live in the schema file and be reviewed in a
// diff; it fills a table at boot when - and only when - the table is empty.
const SEED_CAP = 500;

function seedValue(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

// Inserts the rows, filtering each to the columns the table actually has. Returns the count.
function seedInto(table, rows) {
  const columns = new Set(capture(table).columns.map((c) => c.name));
  let inserted = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const keys = Object.keys(row).filter((k) => columns.has(k) && IDENT_RE.test(k));
    if (keys.length === 0) continue;
    const sql = `INSERT INTO ${quote(table)} (${keys.map(quote).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
    connection().prepare(sql).run(...keys.map((k) => seedValue(row[k])));
    inserted += 1;
  }
  return inserted;
}

function sameValue(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof b === 'boolean') return Number(a) === (b ? 1 : 0);
  if (typeof a === 'bigint') return Number(a) === Number(b);
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) return a === Number(b);
  return String(a) === String(b);
}

// Does the live table hold exactly what this seed produces? Then the seed IS the data, and
// editing it should rewrite the table. Once the app has put its own rows in, it does not.
export function seedInSync(table, rows) {
  const seed = Array.isArray(rows) ? rows : [];
  const { count } = connection().prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get();
  if (Number(count) !== seed.length) return false;
  if (seed.length === 0) return true;
  const live = connection().prepare(`SELECT * FROM ${quote(table)}`).all();
  const used = new Set();
  return seed.every((row) => {
    const keys = Object.keys(row);
    const at = live.findIndex((candidate, i) => !used.has(i) && keys.every((k) => sameValue(candidate[k], row[k])));
    if (at < 0) return false;
    used.add(at);
    return true;
  });
}

// Replace the table's rows with the seed, autoincrement counters included, atomically.
function reseed(table, rows) {
  const db = connection();
  db.exec('BEGIN');
  try {
    db.exec(`DELETE FROM ${quote(table)}`);
    try {
      db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
    } catch {
      // sqlite_sequence only exists once an AUTOINCREMENT table has been created.
    }
    const inserted = seedInto(table, rows);
    db.exec('COMMIT');
    return inserted;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function writeSeed(table, rowsIn) {
  assertTable(table);
  assertNotSystem(table, 'seed');
  if (!Array.isArray(rowsIn)) throw new StoreError('A seed is an array of row objects.');
  if (rowsIn.length > SEED_CAP) throw new StoreError(`A seed is for reference data - keep it under ${SEED_CAP} rows.`);
  const valid = new Set(capture(table).columns.map((c) => c.name));
  const rows = rowsIn.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new StoreError('A seed row must be an object of column: value.');
    const clean = {};
    for (const [key, value] of Object.entries(row)) {
      if (!valid.has(key)) throw new StoreError(`Seed column "${key}" is not in table "${table}".`);
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new StoreError(`Seed value for "${key}" must be a string, number, boolean or null.`);
      }
      clean[key] = value;
    }
    return clean;
  });
  // Decided against the seed as it was: if the table matched it, keep the table matching.
  const previous = readSchema().tables.find((t) => t.name === table)?.seed || [];
  const sync = run(() => seedInSync(table, previous));
  recordTable(table); // adopts an unmanaged table before the seed lands on its entry
  const schema = readSchema();
  schema.tables.find((t) => t.name === table).seed = rows;
  writeSchema(schema);
  let applied = false;
  if (sync) {
    run(() => reseed(table, rows));
    applied = true;
  }
  return { table, rows: rows.length, applied };
}

// Snapshot the live rows into the seed - fill the table by using the app, then capture it.
export function captureSeed(table) {
  assertTable(table);
  assertNotSystem(table, 'capture a seed of');
  return run(() => {
    const { count } = connection().prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get();
    if (Number(count) > SEED_CAP) throw new StoreError(`Table "${table}" has ${count} rows; a seed is for reference data, up to ${SEED_CAP}.`);
    const live = connection().prepare(`SELECT * FROM ${quote(table)}`).all();
    const rows = live.map((row) => {
      const clean = {};
      for (const [key, value] of Object.entries(row)) {
        if (value instanceof Uint8Array) continue; // blobs cannot ride in JSON
        clean[key] = typeof value === 'bigint' ? Number(value) : value;
      }
      return clean;
    });
    return writeSeed(table, rows);
  });
}

// The Seed tab's "apply now": refuses a non-empty table, exactly like boot does.
export function applySeed(table) {
  assertTable(table);
  assertNotSystem(table, 'seed');
  const entry = readSchema().tables.find((t) => t.name === table);
  const rows = Array.isArray(entry?.seed) ? entry.seed : [];
  if (rows.length === 0) throw new StoreError(`Table "${table}" has no seed rows.`);
  const { count } = run(() => connection().prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get());
  if (Number(count) > 0) throw new StoreError(`Table "${table}" is not empty (${count} rows); a seed only fills an empty table.`);
  return run(() => ({ table, inserted: seedInto(table, rows) }));
}

// --- boot reconciliation ----------------------------------------------------

// Column DDL from a schema entry. dflt in the schema is already an SQL literal (as PRAGMA
// reports it), so it is inlined as-is - the schema file is source, trusted like a script.
function columnDdl(column, { inlinePk = false } = {}) {
  assertIdent(column.name, 'column name');
  const type = COLUMN_TYPES.includes(String(column.type).toUpperCase()) ? String(column.type).toUpperCase() : 'TEXT';
  let ddl = `${quote(column.name)} ${type}`;
  if (inlinePk && column.pk) ddl += type === 'INTEGER' ? ' PRIMARY KEY AUTOINCREMENT' : ' PRIMARY KEY';
  if (column.notnull && !column.pk) ddl += ' NOT NULL';
  if (column.dflt !== undefined && column.dflt !== null && String(column.dflt) !== '') ddl += ` DEFAULT ${column.dflt}`;
  const ref = column.references;
  if (ref && ref.table) {
    ddl += ` REFERENCES ${quote(ref.table)}(${quote(ref.column || 'id')}) ON DELETE ${ON_DELETE[ref.onDelete] || 'NO ACTION'}`;
  }
  return ddl;
}

// Parents before children, so seeds can be inserted in one pass. A cycle keeps the schema's
// own order for the tables involved and is reported.
function orderByReferences(tables, warnings) {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const done = new Set();
  const out = [];
  const visiting = new Set();
  const visit = (table, trail) => {
    if (done.has(table.name)) return;
    if (visiting.has(table.name)) {
      warnings.push(`schema: tables reference each other in a cycle (${[...trail, table.name].join(' -> ')})`);
      return;
    }
    visiting.add(table.name);
    for (const column of table.columns || []) {
      const parent = column.references && byName.get(column.references.table);
      if (parent && parent !== table) visit(parent, [...trail, table.name]);
    }
    visiting.delete(table.name);
    done.add(table.name);
    out.push(table);
  };
  for (const table of tables) visit(table, []);
  return out;
}

// Bring the database up to the schema, additively only. Returns what happened; destructive
// drift (columns or types the schema does not know) is reported in warnings and left alone.
export function reconcile() {
  const schema = readSchema();
  const tables = [];
  const skipped = [];
  for (const table of schema.tables) (isSystemTable(table?.name) ? skipped : tables).push(table);
  const result = reconcileTables(tables);
  // A system table's entry may only carry a seed (the users seed lives that way); columns
  // there are ignored, since the structure is AppMaker's.
  for (const table of skipped) {
    if (Array.isArray(table.columns) && table.columns.length) result.warnings.push(`${table.name} is a system table; the columns in its schema entry are ignored`);
  }
  // The secrets list is not reconciled into anything; what is wrong with it is only said.
  result.warnings.push(...secretsOf(schema).warnings);
  return result;
}

// The tables authentication needs, created and completed additively like any other. Called
// when authentication is turned on, and at boot while it is on.
export function reconcileSystem() {
  return reconcileTables(SYSTEM_TABLES.filter((table) => AUTH_TABLE_NAMES.includes(table.name)));
}

// The API keys table, wanted sign-in on or off: at boot, and by the key service before its
// first query on a database that has not seen a boot (a test, the designer's own routes).
export function reconcileApiKeys() {
  return reconcileTables(SYSTEM_TABLES.filter((table) => table.name === 'api_keys'));
}

// The secrets' values table, the same way: at boot, and by the secrets service before its first
// query on a database that has not seen a boot.
export function reconcileSecretValues() {
  return reconcileTables(SYSTEM_TABLES.filter((table) => table.name === 'secret_values'));
}

function reconcileTables(tables) {
  const existing = new Set(listTables());
  const created = [];
  const added = [];
  const seeded = [];
  const warnings = [];

  for (const table of orderByReferences(tables, warnings)) {
    try {
      assertIdent(table.name, 'table name');
    } catch (err) {
      warnings.push(err.message);
      continue;
    }
    const columns = Array.isArray(table.columns) ? table.columns : [];
    if (columns.length === 0) {
      warnings.push(`schema table "${table.name}" has no columns; skipped`);
      continue;
    }
    const indexes = Array.isArray(table.indexes) ? table.indexes : [];

    if (!existing.has(table.name)) {
      const pks = columns.filter((c) => c.pk);
      const parts = columns.map((c) => columnDdl(c, { inlinePk: pks.length === 1 }));
      if (pks.length > 1) parts.push(`PRIMARY KEY (${pks.map((c) => quote(c.name)).join(', ')})`);
      run(() => connection().exec(`CREATE TABLE ${quote(table.name)} (${parts.join(', ')})`));
      for (const ix of indexes) {
        try {
          run(() => connection().exec(indexDdl(table.name, ix)));
        } catch (err) {
          warnings.push(`${table.name} index ${ix.name}: ${err.message}`);
        }
      }
      created.push(table.name);
    } else {
      const live = capture(table.name);
      const liveByName = new Map(live.columns.map((c) => [c.name, c]));
      for (const column of columns) {
        const current = liveByName.get(column.name);
        if (!current) {
          if (column.pk) {
            warnings.push(`${table.name}.${column.name}: a primary key cannot be added to an existing table`);
            continue;
          }
          try {
            run(() => connection().exec(`ALTER TABLE ${quote(table.name)} ADD COLUMN ${columnDdl(column)}`));
            added.push(`${table.name}.${column.name}`);
          } catch (err) {
            warnings.push(`${table.name}.${column.name}: ${err.message}`);
          }
        } else {
          if ((current.type || 'TEXT').toUpperCase() !== String(column.type || 'TEXT').toUpperCase()) {
            warnings.push(`${table.name}.${column.name}: database says ${current.type || 'TEXT'}, schema says ${column.type} - not changed`);
          }
          if (!sameReference(current.references, column.references)) {
            warnings.push(`${table.name}.${column.name}: the link to another table differs between the database and the schema - not changed (Apply it from the Structure tab)`);
          }
        }
      }
      for (const column of live.columns) {
        if (!columns.some((c) => c.name === column.name)) {
          warnings.push(`${table.name}.${column.name}: in the database but not in the schema - left alone`);
        }
      }
      // Indexes are cheap and safe to add; anything extra or different is only reported.
      const liveIndexes = live.indexes || [];
      for (const ix of indexes) {
        const there = liveIndexes.find((l) => l.name === ix.name);
        if (!there) {
          try {
            run(() => connection().exec(indexDdl(table.name, ix)));
            added.push(`${table.name} index ${ix.name}`);
          } catch (err) {
            warnings.push(`${table.name} index ${ix.name}: ${err.message}`);
          }
        } else if (there.columns.join('\n') !== (ix.columns || []).join('\n') || Boolean(there.unique) !== Boolean(ix.unique)) {
          warnings.push(`${table.name} index ${ix.name}: defined differently in the database - not changed`);
        }
      }
      for (const ix of liveIndexes) {
        if (!indexes.some((i) => i.name === ix.name)) warnings.push(`${table.name} index ${ix.name}: in the database but not in the schema - left alone`);
      }
    }

    // The seed lands only in an empty table - a database with data is never touched.
    const rows = Array.isArray(table.seed) ? table.seed : [];
    if (rows.length > 0) {
      try {
        const { count } = connection().prepare(`SELECT COUNT(*) AS count FROM ${quote(table.name)}`).get();
        if (Number(count) === 0) {
          const inserted = run(() => seedInto(table.name, rows));
          if (inserted > 0) seeded.push(`${table.name} (${inserted} rows)`);
        }
      } catch (err) {
        warnings.push(`${table.name} seed: ${err.message}`);
      }
    }
  }

  return { created, added, seeded, warnings };
}

setAuthEnabledHook(async () => {
  const sync = reconcileSystem();
  for (const name of sync.created) console.log(`[db] created table ${name}`);
  for (const warning of sync.warnings) console.warn(`[db] ${warning}`);
  // The seeded Administrator, if the project carries one, gets in as soon as the tables exist.
  const { applyUsersSeedLogged } = await import('./auth/seed.js');
  applyUsersSeedLogged();
});
