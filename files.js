// The project's permanent file store: a folder tree under data_runtime/files, real folders
// and files under whatever names the application gives them, no metadata of any kind - the
// file system is the record. Server scripts reach it through the `files` global (the
// `service` object below); an upload's temporary files are promoted into it by save(); and a
// download is a server function returning send(), which the download route streams. Nothing
// in the store has a URL of its own.
//
// A store path is relative, forward slashes, every segment a plain file name (letters,
// digits, dot, dash and underscore, not starting with a dot), so `..`, absolute paths and
// drive letters cannot be expressed. All disk access goes through storage/local.js, so the
// store could move to a blob service without changing this file's callers.
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { StoreError } from './store.js';
import { LocalStorage } from './storage/local.js';

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MAX_PATH_LENGTH = 512;
// What a download function returns: a marker only the download route understands.
export const FILE_SEND = Symbol('gd.fileSend');
// The only types a download may show in the browser rather than save; anything else - SVG
// and HTML included - is an attachment whatever the function asked.
export const INLINE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

let storage = null;

export function filesRoot() {
  return path.join(config.runtimeDir, 'files');
}

function store() {
  if (!storage || storage.root !== path.resolve(filesRoot())) storage = new LocalStorage(filesRoot());
  return storage;
}

// A folder path may be '' (the root); a file path never is.
export function isStorePath(value, { allowRoot = false } = {}) {
  if (typeof value !== 'string' || value.length > MAX_PATH_LENGTH) return false;
  if (value === '') return allowRoot;
  return value.split('/').every((segment) => SEGMENT_RE.test(segment));
}

export function assertStorePath(value, { allowRoot = false, what = 'path' } = {}) {
  if (!isStorePath(value, { allowRoot })) {
    throw new StoreError(
      `Invalid file ${what} ${JSON.stringify(value)}: use folders separated by "/", each name of letters, digits, dot, dash and underscore, not starting with a dot.`,
      400
    );
  }
  return value;
}

// A file name made safe as a store path segment: anything else becomes "_", runs collapsed,
// nothing left in front of the first letter or digit. Never empty.
export function safeName(name) {
  const out = String(name ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[^A-Za-z0-9]+/, '');
  return out || 'file';
}

export function contentTypeOf(storePath) {
  return express.static.mime.lookup(String(storePath), 'application/octet-stream');
}

const baseName = (storePath) => storePath.slice(storePath.lastIndexOf('/') + 1);

function info(storePath, stat) {
  return { path: storePath, name: baseName(storePath), size: stat.size, modified: stat.modified, folder: stat.folder };
}

async function statOrThrow(storePath) {
  const stat = await store().stat(storePath);
  if (!stat) throw new StoreError(`There is no file or folder at "${storePath}".`, 404);
  return stat;
}

// --- the store's own functions ------------------------------------------------

export async function writeFile(storePath, data) {
  assertStorePath(storePath);
  const existing = await store().stat(storePath);
  if (existing?.folder) throw new StoreError(`"${storePath}" is a folder.`, 409);
  await store().put(storePath, typeof data === 'string' || Buffer.isBuffer(data) ? data : data && typeof data.pipe === 'function' ? data : Buffer.from(data ?? ''));
  return statFile(storePath);
}

export async function readFile(storePath, encoding) {
  assertStorePath(storePath);
  const stat = await statOrThrow(storePath);
  if (stat.folder) throw new StoreError(`"${storePath}" is a folder.`, 409);
  const buffer = await store().get(storePath);
  return encoding ? buffer.toString(encoding) : buffer;
}

export async function openReadStream(storePath) {
  assertStorePath(storePath);
  const stat = await statOrThrow(storePath);
  if (stat.folder) throw new StoreError(`"${storePath}" is a folder.`, 409);
  return store().stream(storePath);
}

export async function statFile(storePath) {
  assertStorePath(storePath, { allowRoot: true });
  if (storePath === '') return { path: '', name: '', size: 0, modified: null, folder: true };
  return info(storePath, await statOrThrow(storePath));
}

export async function exists(storePath) {
  assertStorePath(storePath, { allowRoot: true });
  return store().exists(storePath);
}

// One level of a folder, folders first, each group by name. The root that does not exist yet
// is empty; any other missing folder is a 404.
export async function listFiles(folder = '') {
  assertStorePath(folder, { allowRoot: true, what: 'folder' });
  const entries = await store().list(folder);
  if (entries === null) {
    if (folder === '') return [];
    throw new StoreError(`There is no folder at "${folder}".`, 404);
  }
  return entries
    .map((entry) => ({ name: entry.name, path: folder ? `${folder}/${entry.name}` : entry.name, folder: entry.folder, size: entry.size, modified: entry.modified }))
    .sort((a, b) => (a.folder === b.folder ? a.name.localeCompare(b.name) : a.folder ? -1 : 1));
}

export async function makeFolder(folder) {
  assertStorePath(folder, { what: 'folder' });
  const existing = await store().stat(folder);
  if (existing && !existing.folder) throw new StoreError(`"${folder}" is a file.`, 409);
  await store().mkdir(folder);
  return statFile(folder);
}

// A file or a folder, to a path that must be free.
export async function moveFile(from, to) {
  assertStorePath(from);
  assertStorePath(to);
  await statOrThrow(from);
  if (await store().exists(to)) throw new StoreError(`There is already something at "${to}".`, 409);
  await store().move(from, to);
  return statFile(to);
}

// A file, or an empty folder.
export async function removeFile(storePath) {
  assertStorePath(storePath);
  const stat = await statOrThrow(storePath);
  if (stat.folder) {
    const entries = await store().list(storePath);
    if (entries && entries.length) throw new StoreError(`"${storePath}" is a folder with something in it; use removeFolder to remove it with its contents.`, 409);
  }
  await store().remove(storePath);
  return { path: storePath, removed: true };
}

// A folder and everything in it. The root itself stays.
export async function removeFolder(folder) {
  assertStorePath(folder, { what: 'folder' });
  const stat = await statOrThrow(folder);
  if (!stat.folder) throw new StoreError(`"${folder}" is a file; use remove for a file.`, 409);
  await store().removeTree(folder);
  return { path: folder, removed: true };
}

// Takes a file from outside the store (an upload's part) as the file at storePath.
export async function adoptFile(storePath, sourcePath, { overwrite = false } = {}) {
  assertStorePath(storePath);
  const existing = await store().stat(storePath);
  if (existing?.folder) throw new StoreError(`"${storePath}" is a folder.`, 409);
  if (existing && !overwrite) throw new StoreError(`There is already a file at "${storePath}"; pass { overwrite: true } to replace it.`, 409);
  await store().adopt(storePath, sourcePath);
  return statFile(storePath);
}

// What a download function returns: which file to stream, under what name, and whether the
// browser may show it inline (honoured for pictures only). Checked here, so a function that
// names a missing file fails in its own call.
export async function send(storePath, { name, inline = false } = {}) {
  assertStorePath(storePath);
  const stat = await statOrThrow(storePath);
  if (stat.folder) throw new StoreError(`"${storePath}" is a folder, not a file.`, 409);
  const downloadName = name === undefined || name === null || name === '' ? baseName(storePath) : String(name).replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 255) || baseName(storePath);
  return Object.freeze({ [FILE_SEND]: true, path: storePath, name: downloadName, size: stat.size, inline: Boolean(inline) });
}

export function isFileSend(value) {
  return Boolean(value) && typeof value === 'object' && value[FILE_SEND] === true;
}

// The headers a download goes out with: the type from the extension, never sniffed, never
// allowed to run anything, and an attachment unless the function asked for inline and the
// file is a picture.
export function downloadHeaders(sent) {
  const ext = sent.path.slice(sent.path.lastIndexOf('.') + 1).toLowerCase();
  const inline = sent.inline && sent.path.includes('.') && INLINE_EXTENSIONS.has(ext);
  const ascii = sent.name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(sent.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'Content-Type': contentTypeOf(sent.path),
    'Content-Length': String(sent.size),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`
  };
}

// The `files` global of a server script: the store as a small async file system.
export const service = Object.freeze({
  write: (storePath, data) => writeFile(storePath, data),
  read: (storePath, encoding) => readFile(storePath, encoding),
  stream: (storePath) => openReadStream(storePath),
  stat: (storePath) => statFile(storePath),
  exists: (storePath) => exists(storePath),
  list: (folder) => listFiles(folder === undefined || folder === null ? '' : folder),
  mkdir: (folder) => makeFolder(folder),
  move: (from, to) => moveFile(from, to),
  remove: (storePath) => removeFile(storePath),
  removeFolder: (folder) => removeFolder(folder),
  send: (storePath, options) => send(storePath, options)
});
