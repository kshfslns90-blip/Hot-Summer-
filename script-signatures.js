// The top-level functions of a server script and their parameter names, read off the source:
// what the designer's catalogue types server.require() with, and what an API's argument mapping
// hands a function by name. Parsed here, cached per script by modification time, so neither
// caller parses a file twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import { codePath } from './store.js';

// Column-zero function declarations, as the runner exports them. export/async are optional; a
// default value or a rest marker makes the parameter optional / rest.
const FN_RE = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/gm;
const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

// "a, b = 1, ...rest" -> [{ name, optional, rest }]. A destructured parameter gets a generic name.
export function parseParams(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  const push = (piece, index) => {
    let p = piece.trim();
    if (!p) return;
    const rest = p.startsWith('...');
    if (rest) p = p.slice(3).trim();
    const eq = p.indexOf('=');
    const optional = !rest && eq >= 0;
    if (eq >= 0) p = p.slice(0, eq).trim();
    out.push({ name: IDENT_RE.test(p) ? p : `arg${index + 1}`, optional, rest });
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      push(text.slice(start, i), out.length);
      start = i + 1;
    }
  }
  push(text.slice(start), out.length);
  return out;
}

export function parseFunctions(source) {
  const out = [];
  const seen = new Set();
  FN_RE.lastIndex = 0;
  let match;
  while ((match = FN_RE.exec(String(source || ''))) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, params: parseParams(match[2]) });
  }
  return out;
}

const cache = new Map(); // script file (absolute path) -> { mtimeMs, functions }

// A script is named by its file; a qualified name ("Module.script") means this process's own
// project's file, for the runner's callers. The host, which holds scripts of many projects in
// this one cache, always passes the file.
function fileOf(script) {
  return path.isAbsolute(script) ? script : codePath('server-scripts', script);
}

// The functions of one server script, or null when the script does not exist.
export async function scriptFunctions(script) {
  const file = fileOf(script);
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    cache.delete(file);
    return null;
  }
  const cached = cache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.functions;
  const functions = parseFunctions(await fs.readFile(file, 'utf8'));
  cache.set(file, { mtimeMs: stat.mtimeMs, functions });
  return functions;
}

// The parameters of "Module.script.fn", or null when the script or the function is missing.
export async function functionParams(target) {
  const parts = String(target || '').split('.');
  if (parts.length !== 3) return null;
  const functions = await scriptFunctions(`${parts[0]}.${parts[1]}`);
  const fn = functions && functions.find((f) => f.name === parts[2]);
  return fn ? fn.params : null;
}

// Drops the scripts that no longer exist from the cache. With `under`, a folder, only the
// entries under it are judged: one project's catalogue never evicts another's.
export function pruneSignatures(scripts, { under } = {}) {
  const keep = new Set(scripts.map(fileOf));
  const prefix = under ? `${path.resolve(under)}${path.sep}` : null;
  for (const file of [...cache.keys()]) {
    if (prefix && !file.startsWith(prefix)) continue;
    if (!keep.has(file)) cache.delete(file);
  }
}
