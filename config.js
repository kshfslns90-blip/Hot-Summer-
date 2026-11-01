import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This package's root: the folder holding server/ and public/.
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = {
  // One project's folders. Under the designer the host hands a runner its own through
  // GD_DATA_DIR / GD_RUNTIME_DIR; a deployment names them here.
  dataDir: 'data',
  runtimeDir: 'data_runtime',
  port: 3000,
  // "dev": a runner under the designer, which may hand it the designer API as an extension.
  // "app": a deployed application - no designer API, / opens the app.
  mode: 'dev',
  // A runner listens on loopback: only the preview host is meant to reach it. A standalone
  // runner that should be reachable from elsewhere sets this on purpose.
  bindHost: '127.0.0.1',
  serverRequireAllow: ['path', 'url', 'util', 'crypto'],
  // Background script runs each get a worker thread; this many may run at once, the rest queue.
  workerThreads: Math.max(1, os.availableParallelism() - 1),
  // Uploads from the running app: the most one file may be, the most one selection may add up
  // to, how many files one selection may hold, how many uploads one user may have in progress,
  // the chunk a file travels in, and how long an upload nobody touches keeps its temporary
  // files.
  maxUploadBytes: 200 * 1024 * 1024,
  maxUploadBatchBytes: 1024 * 1024 * 1024,
  maxUploadFiles: 100,
  maxOpenBatches: 10,
  uploadChunkBytes: 4 * 1024 * 1024,
  uploadTempTtlMinutes: 60
};

// config.json: GD_CONFIG names it; else it sits next to this package (a deployment), else one
// level up (the development repo, where the runtime and the designer are two packages of one
// workspace and share the file). Relative paths in it resolve against its own folder.
function locate() {
  if (process.env.GD_CONFIG) return path.resolve(process.env.GD_CONFIG);
  for (const dir of [rootDir, path.dirname(rootDir)]) {
    const file = path.join(dir, 'config.json');
    if (fs.existsSync(file)) return file;
  }
  return path.join(rootDir, 'config.json');
}

function load() {
  const file = locate();
  let fromFile = {};
  try {
    fromFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`config.json is not valid JSON: ${err.message}`);
  }

  const merged = { ...defaults, ...fromFile };
  if (process.env.GD_DATA_DIR) merged.dataDir = process.env.GD_DATA_DIR;
  if (process.env.GD_RUNTIME_DIR) merged.runtimeDir = process.env.GD_RUNTIME_DIR;
  if (process.env.PORT) merged.port = Number(process.env.PORT);
  if (process.env.GD_BIND_HOST) merged.bindHost = process.env.GD_BIND_HOST;
  if (process.env.GD_MODE) merged.mode = process.env.GD_MODE;
  merged.mode = merged.mode === 'app' ? 'app' : 'dev';
  // The runner's own secret from the host that started it; empty when standalone.
  merged.runnerToken = process.env.GD_RUNNER_TOKEN || '';
  // Read once, then gone: project code running in this process (or in a worker thread spawned
  // later, which copies the environment) must not find the secret in process.env. The folders
  // stay, since worker threads read their own copy of this config from them.
  delete process.env.GD_RUNNER_TOKEN;
  // A runner's canonical public address (its preview origin), for the links it puts in mail.
  merged.publicOrigin = process.env.GD_PUBLIC_ORIGIN || '';

  merged.rootDir = rootDir;
  merged.configFile = file;
  merged.configDir = path.dirname(file);
  const base = merged.configDir;
  merged.workerThreads = Math.max(1, Math.floor(Number(merged.workerThreads)) || defaults.workerThreads);
  for (const key of ['maxUploadBytes', 'maxUploadBatchBytes', 'maxUploadFiles', 'maxOpenBatches', 'uploadChunkBytes', 'uploadTempTtlMinutes']) {
    merged[key] = Math.max(1, Math.floor(Number(merged[key])) || defaults[key]);
  }
  merged.dataDir = path.resolve(base, merged.dataDir);
  // Designed artifacts live in dataDir and are yours to version; runtimeDir holds what the engine
  // writes while things are running, which is state rather than source.
  merged.runtimeDir = path.resolve(base, merged.runtimeDir);
  // The schema you design is source and lives in dataDir; the database it materialises into is
  // runtime state and lives in runtimeDir, unless config.json points elsewhere.
  merged.dbFile = path.resolve(base, merged.dbFile || path.join(merged.runtimeDir, 'db', 'app.db'));
  merged.dbSchemaFile = path.resolve(base, merged.dbSchemaFile || path.join(merged.dataDir, 'db', 'schema.json'));
  return merged;
}

export const config = load();
