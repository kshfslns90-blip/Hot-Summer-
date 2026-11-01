// One project's server - the RUNNER. It runs the project and reports on it: the project's own
// APIs at /api, the running application at /app, the form preview at /run, the project's
// pictures at /images, and, for the designer, execution and process state at /designer/api -
// running a script, the database, jobs, workflows, the console - over the one data folder it
// was started for. The project's files themselves are the preview host's to read and write;
// when the host changes them it tells this process (POST /_runner/changed), which re-reads
// what it caches. Standalone (`npm run project`) it listens on config.port;
// under the preview host it is spawned with an ephemeral port, reports it over IPC, and exits
// when the host goes away or asks it to stop.
//
// In app mode (config.mode = "app", what a deployment zip ships with) it is the deployed
// application alone: no designer API, no status for a host, and / opens the app. In development
// the host names an extension (GD_RUNNER_EXTENSION, a module URL) that mounts the designer's
// API; the runtime itself never imports the designer.
import express from 'express';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config } from './config.js';
import * as store from './store.js';
import { run } from './routes/run.js';
import { app as shell, endpoints } from './routes/app.js';
import { boot, engine } from './workflow/index.js';
import { boot as bootJobs, runs, scheduler } from './jobs/index.js';
import { reconcile, reconcileSystem, reconcileApiKeys, reconcileSecretValues, close as closeDb } from './db.js';
import { registry as apis } from './apis.js';
import { sweepUploads } from './uploads.js';
import * as changes from './changes.js';
import { mountStatic } from './static.js';
import { requireRunnerToken, runnerTokenConfigured } from './runner-trust.js';

const APP_MODE = config.mode === 'app';
const app = express();

app.use(express.json({ limit: '8mb' }));
// When the last request other than the host's own status polls came in, for the status below.
let lastRequest = Date.now();
app.use((req, res, next) => {
  if (!req.path.startsWith('/_runner/')) lastRequest = Date.now();
  next();
});
// The designer API, when the host handed this runner an extension that mounts it; it answers the
// host alone once the runner has its secret. A deployed app has no designer at all.
const extension = !APP_MODE && process.env.GD_RUNNER_EXTENSION ? await import(process.env.GD_RUNNER_EXTENSION) : null;
if (extension) extension.mount(app, { requireRunnerToken });
else app.use('/designer/api', (req, res) => res.status(404).json({ error: { message: APP_MODE ? 'This is a deployed application; there is no designer here.' : 'This runner was started without the designer.' } }));
// The project's own APIs, for callers outside the app; then the running application - the
// shell around the forms and the runtime's own API.
app.use('/api', endpoints);
app.use('/app', shell);
app.use('/run', run);

// What the preview host asks before stopping an idle runner: is anything still going on?
// A job run in progress or a live workflow instance counts; an enabled schedule does not - this
// is a development environment, and a job enabled and forgotten must not keep a runner up for
// good. While the runner is down its schedule does not fire; whatever came due meanwhile fires
// once when the runner next starts. The process facts are for the host's administrator: what
// this runner weighs, in either isolation mode, without the host having to look.
if (!APP_MODE) {
  const runtimeVersion = createRequire(import.meta.url)('../package.json').version;
  // The preview host wrote some of this project's files: what this process does about it, per
  // kind (see changes.js). Answered to the host alone, like the status.
  app.post('/_runner/changed', requireRunnerToken, (req, res) => {
    const { applyChanges } = changes;
    applyChanges(req.body || {}).then(
      (answer) => res.json(answer),
      (err) => res.status(500).json({ error: { message: err.message } })
    );
  });
  app.get('/_runner/status', requireRunnerToken, async (req, res, next) => {
    try {
      const schedules = Object.keys(await scheduler.nextRuns()).length;
      const busy = runs.running.size > 0 || engine.live.size > 0;
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage();
      res.json({
        busy,
        idleSince: lastRequest,
        jobs: runs.running.size,
        workflows: engine.live.size,
        schedules,
        process: { pid: process.pid, rss: memory.rss, heapUsed: memory.heapUsed, cpuMs: Math.round((cpu.user + cpu.system) / 1000), uptimeMs: Math.round(process.uptime() * 1000) },
        runtime: runtimeVersion,
        node: process.versions.node
      });
    } catch (err) {
      next(err);
    }
  });
}

// Uploaded pictures - the project's logo, the Picture controls' files - live in the data folder.
// Served without sign-in: the login page shows the logo too.
app.use('/images', express.static(path.join(config.dataDir, 'images'), { fallthrough: true }));
// The app is what this address is for.
app.get('/', (req, res) => res.redirect('/app'));
mountStatic(app);

// A workflow can be waiting for days; one stray rejection should not take the server with it.
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: { message: err.message } });
});

// A data folder from before modules: nothing runs until the forms and scripts have moved.
if (await store.legacyLayout()) {
  console.error(`The data folder ${config.dataDir} keeps its forms and scripts loose, from before modules existed.`);
  console.error(`Run "node tools/migrate-modules.mjs ${config.dataDir}" once to move them into the Main module, then start again.`);
  process.exit(1);
}
await store.ensureDirs();
// The settings are read once here; request guards then consult the copy in memory.
const settings = await store.readProject();
// The database catches up with the designed schema - additively; drift is reported, not fixed.
// A project with authentication also gets the users and sessions tables it needs.
// The API keys table is wanted sign-in on or off: the designer issues keys either way.
const syncs = [reconcile(), reconcileApiKeys()];
if (settings.auth.enabled) syncs.push(reconcileSystem());
// The secrets' values table: a failure there is said and the app starts all the same - only
// the secrets would be missing, and their service makes the table again at its first call.
try {
  syncs.push(reconcileSecretValues());
} catch (err) {
  console.warn(`[db] secret_values: ${err.message}`);
}
for (const sync of syncs) {
  for (const name of sync.created) console.log(`[db] created table ${name}`);
  for (const column of sync.added) console.log(`[db] added column ${column}`);
  for (const seed of sync.seeded) console.log(`[db] seeded ${seed}`);
  for (const warning of sync.warnings) console.warn(`[db] ${warning}`);
}
// A project that carries a seeded Administrator gets one wherever none exists yet.
if (settings.auth.enabled) {
  const { applyUsersSeedLogged } = await import('./auth/seed.js');
  applyUsersSeedLogged();
  const { purgeExpiredSessions } = await import('./auth/service.js');
  const purged = purgeExpiredSessions();
  if (purged) console.log(`[auth] removed ${purged} expired session(s)`);
}
// Anything that was mid-flight when the process last stopped picks up where it left off.
await boot();
// Job runs cannot resume - the sweep marks them interrupted - and schedules re-arm.
await bootJobs();
// The project's APIs, as one router; the designer refreshes it after every write.
await apis.refresh();
// Uploads nobody finished lose their temporary files: now, and every ten minutes from now.
await sweepUploads().catch((err) => console.warn(`[uploads] sweep: ${err.message}`));
const uploadSweep = setInterval(() => sweepUploads().catch((err) => console.warn(`[uploads] sweep: ${err.message}`)), 10 * 60 * 1000);
uploadSweep.unref();

const server = app.listen(config.port, config.bindHost, () => {
  const { port } = server.address();
  if (process.send) process.send({ type: 'listening', port });
  else if (APP_MODE) {
    console.log(`${settings.name} running at http://${config.bindHost}:${port}/app`);
  } else {
    console.log(`AppMaker project server running at http://${config.bindHost}:${port}`);
    console.log(`Data folder:    ${config.dataDir}`);
    console.log(`Runtime folder: ${config.runtimeDir}`);
  }
  if (extension && !runnerTokenConfigured()) console.warn('[runner] development mode: the designer API at /designer/api is open to anyone who can reach this port');
});

// Under the host: stop when asked, and when the host is gone (its IPC channel closes).
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  clearInterval(uploadSweep);
  scheduler.stop();
  runs.stop();
  if (engine.timer !== null) engine.clearTimer(engine.timer);
  server.close();
  try {
    closeDb();
  } catch {
    /* already closed */
  }
  setTimeout(() => process.exit(code), 200).unref();
}
process.on('message', (msg) => {
  if (msg && msg.type === 'stop') shutdown(0);
});
process.on('disconnect', () => shutdown(0));
// In a container there is no IPC channel: `docker stop` sends SIGTERM, and a deployed app under
// a service manager gets the same. Both close the database the way a stop message does.
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
