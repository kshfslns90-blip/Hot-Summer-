// The upload transport: one selection of files in the browser is one BATCH, every file in it
// has its own upload id, and each file arrives in chunks written straight into a part file
// under data_runtime/tmp/uploads/<batchId>/. Once every chunk of every file is there, the
// batch's handler - a server script function - is called once with the batch's temporary
// files, and keeps what it wants by calling save() on them; afterwards the batch folder goes,
// promoted files or not. Application code never sees a chunk, a retry or a batch id.
//
// The batch's own state lives in batch.json next to the parts (what is expected, what has
// arrived, when it last moved), written atomically and only ever changed under the batch's
// mutex, so overlapping chunk requests cannot lose a mark and a complete sees a consistent
// batch. The chunk bytes themselves go to their own offsets outside the mutex, in parallel.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { StoreError } from './store.js';
import * as store from './store.js';
import { parseTarget as parseServerTarget, callServer } from './runner.js';
import { assertStorePath, safeName as toSafeName, adoptFile } from './files.js';

// A completed batch's answer is remembered this long, so a client whose response was lost can
// ask again and get the same answer without the handler running twice.
export const OUTCOME_RETENTION_MS = 10 * 60 * 1000;

const ID_RE = /^[a-f0-9]{16}$/;

export function uploadsRoot() {
  return path.join(config.runtimeDir, 'tmp', 'uploads');
}

const batchDir = (id) => path.join(uploadsRoot(), id);
const batchFile = (id) => path.join(batchDir(id), 'batch.json');
const partFile = (id, uploadId) => path.join(batchDir(id), `${uploadId}.part`);

// --- the per-batch mutex ----------------------------------------------------------

const chains = new Map();

// Runs fn after everything already queued for the batch; the batch's state is only ever
// changed inside one of these.
export function withBatch(id, fn) {
  const previous = chains.get(id) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  chains.set(id, next);
  next.then(
    () => {
      if (chains.get(id) === next) chains.delete(id);
    },
    () => {
      if (chains.get(id) === next) chains.delete(id);
    }
  );
  return next;
}

// --- state on disk -------------------------------------------------------------------

async function writeBatch(batch) {
  const file = batchFile(batch.id);
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(batch), 'utf8');
  await fsp.rename(tmp, file);
}

const notFound = (id) => new StoreError(`Upload batch "${id}" does not exist (or it has already completed and been forgotten).`, 404);

async function readBatch(id) {
  if (!ID_RE.test(String(id))) throw notFound(id);
  let raw;
  try {
    raw = await fsp.readFile(batchFile(id), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') throw notFound(id);
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw notFound(id);
  }
}

// A batch is its creator's: anyone else asking gets the same answer as for no batch at all.
function assertOwner(batch, owner) {
  if (owner !== undefined && batch.owner !== owner) throw notFound(batch.id);
  return batch;
}

// --- the incoming names -------------------------------------------------------------

// The name the browser sent is data about the file, not a location: only what could do harm
// when shown or logged goes - a path in front of it, control characters, excess length.
export function cleanName(raw) {
  let name = String(raw ?? '');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length > 255) name = name.slice(0, 255);
  return name || 'file';
}

export { toSafeName as safeName };

// --- open batches per owner -------------------------------------------------------------

const openByOwner = new Map();

function trackOpen(owner, id) {
  if (!openByOwner.has(owner)) openByOwner.set(owner, new Set());
  openByOwner.get(owner).add(id);
}

function untrackOpen(owner, id) {
  const set = openByOwner.get(owner);
  if (!set) return;
  set.delete(id);
  if (set.size === 0) openByOwner.delete(owner);
}

export function openBatches(owner) {
  return openByOwner.get(owner)?.size || 0;
}

// --- the batch life cycle ---------------------------------------------------------------

function describe(batch) {
  return {
    batchId: batch.id,
    chunkSize: batch.chunkSize,
    files: Object.entries(batch.files).map(([uploadId, file]) => ({ uploadId, name: file.name, type: file.type, size: file.size, chunks: file.chunks }))
  };
}

// The handler is validated here the way a call target is, so a wrong name fails before any
// byte is sent: it must be a complete "Module.script.fn" whose script exists.
async function checkHandler(handler) {
  let parsed;
  try {
    parsed = parseServerTarget(handler);
  } catch (err) {
    throw new StoreError(`The upload handler is not a valid target: ${err.message}`, 400);
  }
  if (!(await store.exists('server-scripts', parsed.name))) {
    throw new StoreError(`The upload handler names a server script that does not exist: "${parsed.name}".`, 400);
  }
  return parsed.target;
}

export async function createBatch({ handler, owner, files } = {}) {
  const target = await checkHandler(handler);
  if (!Array.isArray(files) || files.length === 0) throw new StoreError('An upload batch needs at least one file.', 400);
  if (files.length > config.maxUploadFiles) throw new StoreError(`An upload batch takes at most ${config.maxUploadFiles} files.`, 413);
  const ownerKey = String(owner ?? 'anonymous');
  if (openBatches(ownerKey) >= config.maxOpenBatches) throw new StoreError(`Too many uploads in progress (${config.maxOpenBatches}); let one finish first.`, 429);
  const chunkSize = config.uploadChunkBytes;
  const entries = {};
  let total = 0;
  const ids = new Set();
  for (const file of files) {
    const size = Number(file?.size);
    if (!Number.isInteger(size) || size < 0) throw new StoreError(`Each file needs a size in bytes (got ${JSON.stringify(file?.size)}).`, 400);
    if (size > config.maxUploadBytes) throw new StoreError(`"${cleanName(file?.name)}" is ${size} bytes; a file is at most ${config.maxUploadBytes} bytes.`, 413);
    total += size;
    if (total > config.maxUploadBatchBytes) throw new StoreError(`The files together exceed ${config.maxUploadBatchBytes} bytes per upload.`, 413);
    let uploadId;
    do uploadId = crypto.randomBytes(8).toString('hex');
    while (ids.has(uploadId));
    ids.add(uploadId);
    entries[uploadId] = {
      name: cleanName(file?.name),
      type: String(file?.type || '').replace(/[^\x21-\x7e]/g, '').slice(0, 200) || 'application/octet-stream',
      size,
      chunkSize,
      chunks: Math.ceil(size / chunkSize),
      received: []
    };
  }
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const batch = { id, handler: target, owner: ownerKey, createdAt: now, updatedAt: now, chunkSize, files: entries };
  await fsp.mkdir(batchDir(id), { recursive: true });
  for (const uploadId of Object.keys(entries)) await fsp.writeFile(partFile(id, uploadId), Buffer.alloc(0));
  await writeBatch(batch);
  trackOpen(ownerKey, id);
  return describe(batch);
}

function chunkLength(file, index) {
  return index < file.chunks - 1 ? file.chunkSize : file.size - index * file.chunkSize;
}

// The chunk's bytes go to their offset in the part at once; only the mark that it arrived
// waits for the batch's turn. Sending a chunk twice is fine: same bytes, same place.
export async function writeChunk(id, uploadId, index, buffer, { owner } = {}) {
  const batch = assertOwner(await readBatch(id), owner);
  const file = batch.files[uploadId];
  if (!file) throw new StoreError(`Upload "${uploadId}" is not part of batch "${id}".`, 404);
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= file.chunks) throw new StoreError(`Chunk ${index} is out of range; "${file.name}" has ${file.chunks} chunk(s).`, 400);
  if (!Buffer.isBuffer(buffer)) throw new StoreError('A chunk is sent as the raw request body.', 400);
  const expected = chunkLength(file, at);
  if (buffer.length !== expected) throw new StoreError(`Chunk ${at} of "${file.name}" should be ${expected} bytes, not ${buffer.length}.`, 400);
  let handle;
  try {
    handle = await fsp.open(partFile(id, uploadId), 'r+');
  } catch (err) {
    if (err.code === 'ENOENT') throw notFound(id);
    throw err;
  }
  try {
    await handle.write(buffer, 0, buffer.length, at * file.chunkSize);
  } finally {
    await handle.close();
  }
  return withBatch(id, async () => {
    const current = await readBatch(id);
    const entry = current.files[uploadId];
    if (!entry) throw notFound(id);
    if (!entry.received.includes(at)) entry.received.push(at);
    current.updatedAt = new Date().toISOString();
    await writeBatch(current);
    return { received: entry.received.length, chunks: entry.chunks };
  });
}

// Which chunks are still missing, per file: what a client resends after a failure.
export async function batchState(id, { owner } = {}) {
  const batch = assertOwner(await readBatch(id), owner);
  return {
    batchId: batch.id,
    chunkSize: batch.chunkSize,
    files: Object.entries(batch.files).map(([uploadId, file]) => {
      const have = new Set(file.received);
      const missing = [];
      for (let i = 0; i < file.chunks; i += 1) if (!have.has(i)) missing.push(i);
      return { uploadId, name: file.name, size: file.size, chunks: file.chunks, received: file.received.length, missing };
    })
  };
}

// The temporary file a handler gets: the received bytes to read, and save() to make the file
// permanent at a store path. Once the handler is done, whatever was not saved is deleted.
function tempFile(batch, uploadId, file, saved) {
  const part = partFile(batch.id, uploadId);
  let promoted = null;
  const temp = {
    uploadId,
    name: file.name,
    safeName: toSafeName(file.name),
    type: file.type,
    size: file.size,
    read: () => fsp.readFile(part),
    readText: (encoding = 'utf8') => fsp.readFile(part, encoding),
    openReadStream: () => fs.createReadStream(part),
    async save(storePath, options = {}) {
      if (promoted) throw new StoreError(`"${file.name}" has already been saved as "${promoted.path}".`, 409);
      const target = storePath === undefined || storePath === null || storePath === '' ? temp.safeName : String(storePath);
      assertStorePath(target);
      promoted = await adoptFile(target, part, { overwrite: Boolean(options && options.overwrite) });
      saved.set(uploadId, promoted);
      return promoted;
    }
  };
  return temp;
}

// The remembered outcomes of completed batches: { at, value } or { at, error }.
const outcomes = new Map();

export function expireOutcomes(now = Date.now(), retention = OUTCOME_RETENTION_MS) {
  for (const [id, outcome] of outcomes) if (now - outcome.at > retention) outcomes.delete(id);
}

async function removeBatchDir(batch) {
  await fsp.rm(batchDir(batch.id), { recursive: true, force: true });
  untrackOpen(batch.owner, batch.id);
}

// Runs the handler once with the batch's files and answers { result, files }. Under the
// batch's mutex, so a second complete arriving meanwhile waits and then finds the remembered
// outcome; the outcome stays for OUTCOME_RETENTION_MS, after which the batch is unknown.
export async function completeBatch(id, { owner, user = null, run } = {}) {
  return withBatch(id, async () => {
    const remembered = outcomes.get(id);
    if (remembered) {
      if (remembered.error) throw remembered.error;
      return remembered.value;
    }
    const batch = assertOwner(await readBatch(id), owner);
    for (const [uploadId, file] of Object.entries(batch.files)) {
      if (file.received.length !== file.chunks) {
        throw new StoreError(`"${file.name}" is not complete yet (${file.received.length} of ${file.chunks} chunks).`, 409);
      }
      const info = await fsp.stat(partFile(id, uploadId)).catch(() => null);
      if (!info || info.size !== file.size) throw new StoreError(`"${file.name}" is not complete yet.`, 409);
    }
    const saved = new Map();
    const files = Object.entries(batch.files).map(([uploadId, file]) => tempFile(batch, uploadId, file, saved));
    const call = run || callServer;
    const remember = (outcome) => {
      outcomes.set(id, { at: Date.now(), ...outcome });
      const timer = setTimeout(() => expireOutcomes(), OUTCOME_RETENTION_MS + 1000);
      if (timer.unref) timer.unref();
    };
    let result;
    try {
      result = await call(batch.handler, [{ files }], { user });
    } catch (err) {
      await removeBatchDir(batch);
      const error = err instanceof Error ? err : new Error(String(err));
      if (!error.status) error.status = 500;
      remember({ error });
      throw error;
    }
    await removeBatchDir(batch);
    const value = {
      result: result === undefined ? null : result,
      files: Object.entries(batch.files).map(([uploadId, file]) => ({ uploadId, name: file.name, type: file.type, size: file.size, saved: saved.get(uploadId) || null }))
    };
    remember({ value });
    return value;
  });
}

// The client's cleanup after a failure it could not retry through.
export async function abortBatch(id, { owner } = {}) {
  return withBatch(id, async () => {
    const batch = assertOwner(await readBatch(id), owner);
    await removeBatchDir(batch);
    return { batchId: id, aborted: true };
  });
}

// Batches nobody has touched for the TTL are abandoned: a closed tab, a lost connection. One
// that keeps delivering chunks renews itself; one whose handler is running holds its mutex,
// so the sweep waits and then finds it gone.
export async function sweepUploads({ now = Date.now(), ttlMs = config.uploadTempTtlMinutes * 60 * 1000 } = {}) {
  expireOutcomes(now);
  let entries;
  try {
    entries = await fsp.readdir(uploadsRoot(), { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removed: 0 };
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
    const id = entry.name;
    await withBatch(id, async () => {
      let batch = null;
      try {
        batch = await readBatch(id);
      } catch (err) {
        if (!(err instanceof StoreError)) throw err;
      }
      if (batch && now - Date.parse(batch.updatedAt || batch.createdAt || 0) <= ttlMs) return;
      await fsp.rm(batchDir(id), { recursive: true, force: true });
      if (batch) untrackOpen(batch.owner, id);
      removed += 1;
    });
  }
  return { removed };
}

// Does this batch's folder exist? For tests and the sweep's callers.
export async function batchExists(id) {
  try {
    await fsp.access(batchDir(id));
    return true;
  } catch {
    return false;
  }
}
