// Secrets: the keys, tokens and passwords a project's server code needs, read with
// getSecret(name). Two halves, kept apart:
//
//   - the DEFINITIONS - name and description - are design: a `secrets` list in the schema file,
//     beside the tables, so they travel with the project (Git, export, templates, deploy zip);
//   - the VALUES are deployment data: sealed with the project's own key in the secret_values
//     system table, set where the app runs, never written to a project file and never shown
//     again - a listing says only whether each one is configured.
//
// The key is 32 random bytes in <runtimeDir>/secrets.key, made by the first value write and
// read from disk at every call (no cache), so a key restored, replaced or removed by hand counts
// at once. A key is never made while sealed values remain that need the old one: a lost or
// damaged key is reported, and resetUnreadable() is the deliberate way out. AES-256-GCM, with
// the value row's id as additional data, so a sealed value moved to another row does not open.
//
// The designer's Secrets panel and the app's Secrets page (Administrators) both come here,
// through routes/secrets.js; server scripts through the getSecret service of runner.js.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { connection, query, execute, readSchema, writeSchemaSecrets, reconcileSecretValues } from './db.js';
import { StoreError } from './store.js';
import { secretsOf, SECRET_NAME_RE, SECRET_NAME_MAX, SECRET_DESCRIPTION_MAX } from './schema-file.js';

export const VALUE_MAX_BYTES = 16 * 1024;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT = 'v1';

// An error with what a page needs to show it: the status, the field it belongs to, a code.
function fail(message, status, extra = {}) {
  const err = new StoreError(message, status);
  Object.assign(err, extra);
  return err;
}

let ready = false;
function ensureTable() {
  if (ready) return;
  reconcileSecretValues();
  ready = true;
}

// For tests that swap the database or the folders underneath.
let renameFile = (from, to) => fs.renameSync(from, to);
export function resetSecrets({ rename } = {}) {
  ready = false;
  renameFile = rename || ((from, to) => fs.renameSync(from, to));
}

// --- the key ------------------------------------------------------------------

export function keyFile() {
  return path.join(config.runtimeDir, 'secrets.key');
}

// A short fingerprint of a key, stored with every value it seals: a value whose fingerprint is
// not the current key's was sealed with another one.
function keyIdOf(key) {
  return crypto.createHmac('sha256', key).update('appmaker-secret-key-id').digest('hex').slice(0, 16);
}

// { state: 'ok', key, id } | { state: 'missing' } | { state: 'invalid' }, read now.
function readKey() {
  let text;
  try {
    text = fs.readFileSync(keyFile(), 'utf8').trim();
  } catch (err) {
    return err.code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid' };
  }
  const key = Buffer.from(text, 'base64');
  if (key.length !== KEY_BYTES || key.toString('base64') !== text) return { state: 'invalid' };
  return { state: 'ok', key, id: keyIdOf(key) };
}

// The key a value write seals with. Made here when there is none and no sealed value at all;
// otherwise a missing or damaged key stops the write, whatever the value - a new key would
// strand every value sealed with the old one.
function writableKey() {
  const current = readKey();
  if (current.state === 'ok') return current;
  if (current.state === 'invalid') {
    throw fail("This project's encryption key file (secrets.key) is damaged, so no value can be saved. Restore it from a backup, or reset the unreadable values.", 409, { code: 'key_invalid' });
  }
  const sealed = sealedRows().length;
  if (sealed) {
    throw fail(`This project's encryption key file (secrets.key) is missing; ${sealed} stored value${sealed === 1 ? '' : 's'} can't be read. Restore it from a backup, or reset the unreadable values.`, 409, { code: 'key_missing', unreadable: sealed });
  }
  const text = crypto.randomBytes(KEY_BYTES).toString('base64');
  try {
    fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
    fs.writeFileSync(keyFile(), `${text}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    // A key put back at this very moment is the key: never written over.
    if (err.code !== 'EEXIST') throw err;
    return writableKey();
  }
  return readKey();
}

// --- sealing ------------------------------------------------------------------

const b64u = (buffer) => buffer.toString('base64url');
const aad = (rowId) => Buffer.from(`secret:${rowId}`, 'utf8');

function seal(key, rowId, value) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(aad(rowId));
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [FORMAT, key.id, b64u(iv), b64u(sealed), b64u(cipher.getAuthTag())].join('.');
}

// { ok: true, value } or { ok: false, reason }: key-missing, key-invalid, key-mismatch or
// undecryptable.
function open(key, row) {
  if (key.state === 'missing') return { ok: false, reason: 'key-missing' };
  if (key.state === 'invalid') return { ok: false, reason: 'key-invalid' };
  const parts = String(row.sealedValue).split('.');
  if (parts.length !== 5 || parts[0] !== FORMAT) return { ok: false, reason: 'undecryptable' };
  if (parts[1] !== key.id) return { ok: false, reason: 'key-mismatch' };
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key.key, Buffer.from(parts[2], 'base64url'));
    decipher.setAAD(aad(row.id));
    decipher.setAuthTag(Buffer.from(parts[4], 'base64url'));
    const value = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
    return { ok: true, value };
  } catch {
    return { ok: false, reason: 'undecryptable' };
  }
}

// --- the rows and the definitions ---------------------------------------------

function sealedRows() {
  ensureTable();
  return query('SELECT id, name, sealedValue, valueSetAt FROM secret_values WHERE sealedValue IS NOT NULL ORDER BY id').map((row) => ({ ...row, id: Number(row.id) }));
}

function rowNamed(name) {
  ensureTable();
  const row = query('SELECT id, name, sealedValue, valueSetAt FROM secret_values WHERE name = ?', [name])[0];
  return row ? { ...row, id: Number(row.id) } : null;
}

function definitions() {
  return secretsOf(readSchema()).secrets;
}

// The schema's list as it is, entries this module would skip included, for a write that keeps
// what it does not touch.
function rawList() {
  const list = readSchema().secrets;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw fail('The schema file\'s "secrets" is not a list. Fix db/schema.json first.', 409);
  return list;
}

function definitionNamed(name) {
  const def = definitions().find((d) => d.name === name);
  if (!def) throw fail(`No secret named "${name}" is defined.`, 404);
  return def;
}

function cleanName(name, { except = null } = {}) {
  const value = typeof name === 'string' ? name.trim() : '';
  if (!value) throw fail('A secret needs a name.', 400, { field: 'name' });
  if (!SECRET_NAME_RE.test(value)) throw fail('A name is letters, digits and underscores, starting with a letter - e.g. STRIPE_API_KEY.', 400, { field: 'name' });
  if (value.length > SECRET_NAME_MAX) throw fail(`A name is at most ${SECRET_NAME_MAX} characters.`, 400, { field: 'name' });
  const clash = definitions().find((d) => d.name.toLowerCase() === value.toLowerCase() && d.name !== except);
  if (clash) throw fail(`There is already a secret named "${clash.name}".`, 409, { field: 'name' });
  return value;
}

function cleanDescription(description) {
  if (description === undefined || description === null) return '';
  if (typeof description !== 'string') throw fail('A description is text.', 400, { field: 'description' });
  const value = description.trim();
  if (value.length > SECRET_DESCRIPTION_MAX) throw fail(`A description is at most ${SECRET_DESCRIPTION_MAX} characters.`, 400, { field: 'description' });
  return value;
}

// A value is kept exactly as given - line breaks and surrounding spaces included; whether to
// trim them is the person's choice, made on the page before it is sent.
function cleanValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw fail('Type or paste the value.', 400, { field: 'value' });
  if (Buffer.byteLength(value, 'utf8') > VALUE_MAX_BYTES) throw fail(`A value is at most ${VALUE_MAX_BYTES / 1024} KB.`, 400, { field: 'value' });
  return value;
}

// What one definition looks like from outside: its state, never its value.
function entryOf(def, row, key) {
  if (!row || row.sealedValue === null || row.sealedValue === undefined) return { name: def.name, description: def.description, state: 'not-configured', valueSetAt: null };
  const opened = open(key, row);
  if (opened.ok) return { name: def.name, description: def.description, state: 'configured', valueSetAt: row.valueSetAt || null };
  return { name: def.name, description: def.description, state: 'unavailable', reason: opened.reason, valueSetAt: row.valueSetAt || null };
}

// The values a reset would clear now: with a valid key, the defined secrets' values that do not
// open (the key is left alone); with a missing or damaged key, every stored value.
function resetTargets(key, rows, defs) {
  if (key.state !== 'ok') return rows;
  const defined = new Set(defs.map((d) => d.name));
  return rows.filter((row) => defined.has(row.name) && !open(key, row).ok);
}

function keyState(key, rows) {
  if (key.state === 'missing') return rows.length ? 'missing' : 'none';
  return key.state;
}

// --- the service ----------------------------------------------------------------

export function listSecrets() {
  const defs = definitions();
  const rows = sealedRows();
  const byName = new Map(rows.map((row) => [row.name, row]));
  const key = readKey();
  return {
    secrets: defs.map((def) => entryOf(def, byName.get(def.name), key)),
    key: { state: keyState(key, rows), unreadable: resetTargets(key, rows, defs).length }
  };
}

function entryNamed(name) {
  return listSecrets().secrets.find((s) => s.name === name) || null;
}

// A new definition, with its value when one is given. A value left behind under that name (its
// secret renamed or removed outside the designer) goes: a new secret starts clean.
export function defineSecret({ name, description, value } = {}) {
  const cleanedName = cleanName(name);
  const cleanedDescription = cleanDescription(description);
  const withValue = value !== undefined && value !== null && value !== '';
  if (withValue) {
    cleanValue(value);
    writableKey();
  }
  const list = rawList();
  ensureTable();
  execute('DELETE FROM secret_values WHERE lower(name) = lower(?)', [cleanedName]);
  writeSchemaSecrets([...list, { name: cleanedName, description: cleanedDescription }]);
  if (withValue) setSecretValue(cleanedName, value);
  return entryNamed(cleanedName);
}

// A rename moves the value with it: the row is renamed, and a value sealed with its row id
// opens the same under any name.
export function updateSecret(name, { name: newName, description } = {}) {
  const def = definitionNamed(name);
  const target = newName === undefined || newName === null || newName === def.name ? def.name : cleanName(newName, { except: def.name });
  const cleanedDescription = description === undefined ? def.description : cleanDescription(description);
  const list = rawList();
  const next = list.map((entry) => (entry && entry.name === def.name ? { ...entry, name: target, description: cleanedDescription } : entry));
  writeSchemaSecrets(next);
  if (target !== def.name) {
    try {
      ensureTable();
      // A value left under the new name belongs to no secret; the renamed one's takes its place.
      execute('DELETE FROM secret_values WHERE name = ?', [target]);
      execute('UPDATE secret_values SET name = ? WHERE name = ?', [target, def.name]);
    } catch (err) {
      writeSchemaSecrets(list);
      throw err;
    }
  }
  return entryNamed(target);
}

export function setSecretValue(name, value) {
  definitionNamed(name);
  const cleaned = cleanValue(value);
  const key = writableKey();
  ensureTable();
  const db = connection();
  db.exec('BEGIN');
  try {
    let row = rowNamed(name);
    if (!row) {
      const result = execute('INSERT INTO secret_values (name) VALUES (?)', [name]);
      row = { id: Number(result.lastInsertRowid) };
    }
    execute('UPDATE secret_values SET sealedValue = ?, valueSetAt = ? WHERE id = ?', [seal(key, row.id, cleaned), new Date().toISOString(), row.id]);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return entryNamed(name);
}

export function deleteSecret(name) {
  const def = definitionNamed(name);
  writeSchemaSecrets(rawList().filter((entry) => !(entry && entry.name === def.name)));
  ensureTable();
  execute('DELETE FROM secret_values WHERE name = ?', [def.name]);
  return { name: def.name, deleted: true };
}

// The value, for getSecret: a clear message for each way it can be absent.
export function readSecret(name) {
  if (typeof name !== 'string' || !name) throw fail('getSecret needs the secret\'s name, e.g. getSecret(\'STRIPE_API_KEY\').', 500, { code: 'secret_undefined' });
  const defs = definitions();
  const def = defs.find((d) => d.name === name);
  if (!def) {
    const near = defs.find((d) => d.name.toLowerCase() === name.toLowerCase());
    throw fail(`No secret named "${name}" is defined.${near ? ` Did you mean "${near.name}"?` : ' Add it in Secrets.'}`, 500, { code: 'secret_undefined' });
  }
  const row = rowNamed(name);
  if (!row || row.sealedValue === null || row.sealedValue === undefined) {
    throw fail(`The secret "${name}" has no value yet. Set it in Secrets.`, 500, { code: 'secret_not_configured' });
  }
  const opened = open(readKey(), row);
  if (opened.ok) return opened.value;
  const why = {
    'key-missing': "this project's encryption key file (secrets.key) is missing",
    'key-invalid': "this project's encryption key file (secrets.key) is damaged",
    'key-mismatch': 'it was saved with a different encryption key',
    undecryptable: 'its stored value is damaged'
  }[opened.reason];
  throw fail(`The secret "${name}" can't be read: ${why}. Restore secrets.key from a backup, or set the value again in Secrets.`, 500, { code: 'secret_unavailable', reason: opened.reason });
}

// The way out when values can't be opened. `expect` is the count the person confirmed: when
// the count is different now, nothing is done. Two steps, not one atomic act - the values go in
// one transaction, then a damaged key file is set aside (renamed, never deleted); should the
// second step not happen, what is left is a damaged key with no value depending on it, which a
// reset with expect 0 sets aside.
export function resetUnreadable({ expect } = {}) {
  const expected = Number(expect);
  if (!Number.isInteger(expected) || expected < 0) throw fail('Say how many values the reset is to clear (expect).', 400);
  const key = readKey();
  const defs = definitions();
  const db = connection();
  let cleared;
  ensureTable();
  db.exec('BEGIN');
  try {
    const targets = resetTargets(key, sealedRows(), defs);
    if (targets.length !== expected) {
      throw fail(`${targets.length} value${targets.length === 1 ? '' : 's'} would be cleared now, not ${expected}. Look at the list again before you reset.`, 409, { code: 'reset_count_changed' });
    }
    for (const row of targets) execute('DELETE FROM secret_values WHERE id = ?', [row.id]);
    cleared = targets.length;
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  let keySetAside = null;
  if (key.state === 'invalid') {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    let target = `${keyFile()}.unreadable-${stamp}`;
    for (let n = 2; fs.existsSync(target); n += 1) target = `${keyFile()}.unreadable-${stamp}-${n}`;
    renameFile(keyFile(), target);
    keySetAside = path.basename(target);
  }
  return { mode: key.state === 'ok' ? 'partial' : 'start-over', cleared, keySetAside };
}
