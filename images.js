// Uploaded pictures: data/images, served at /images/<name>. The project's logo and the Picture
// control's src point here. A name is a plain file name with a picture extension - the first
// path defence, so it is strict - and an upload under an existing name replaces it. Like the
// store, a function of a folder: imagesIn(dataDir) for any project, the module-level exports
// for this process's own.
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { StoreError, insideFile } from './store.js';

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'];
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isImageName(name) {
  if (typeof name !== 'string' || name.length > 120 || !NAME_RE.test(name) || name.includes('..')) return false;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return name.includes('.') && IMAGE_EXTENSIONS.includes(ext);
}

export function assertImageName(name) {
  if (!isImageName(name)) {
    throw new StoreError(`"${name}" is not a valid picture name: letters, digits, dots, dashes and underscores, ending in ${IMAGE_EXTENSIONS.join(', ')}.`, 400);
  }
  return name;
}

export function imageUrl(name) {
  return isImageName(name) ? `/images/${encodeURIComponent(name)}` : '';
}

export function imagesIn(where) {
  const root = typeof where === 'function' ? where : () => where;
  const dir = () => path.join(root(), 'images');

  // Regular files with picture names; a link is not listed (isFile is false for one).
  async function list() {
    let entries;
    try {
      entries = await fs.readdir(dir(), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const images = [];
    for (const entry of entries) {
      if (!entry.isFile() || !isImageName(entry.name)) continue;
      const stat = await fs.stat(path.join(dir(), entry.name));
      images.push({ name: entry.name, url: imageUrl(entry.name), size: stat.size, modified: stat.mtime.toISOString() });
    }
    return images.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function save(name, buffer) {
    assertImageName(name);
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new StoreError('The picture is empty.', 400);
    if (buffer.length > MAX_IMAGE_BYTES) throw new StoreError(`A picture is at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`, 413);
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(await insideFile(root(), path.join(dir(), name)), buffer);
    return { name, url: imageUrl(name), size: buffer.length };
  }

  async function remove(name) {
    assertImageName(name);
    try {
      await fs.unlink(path.join(dir(), name));
    } catch (err) {
      if (err.code === 'ENOENT') throw new StoreError(`There is no picture named "${name}".`, 404);
      throw err;
    }
    return { ok: true };
  }

  return { dir, list, save, remove };
}

const own = imagesIn(() => config.dataDir);

export const imagesDir = own.dir;
export const listImages = own.list;
export const saveImage = own.save;
export const removeImage = own.remove;
