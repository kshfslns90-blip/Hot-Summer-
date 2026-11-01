// What a running project does about a change to its files, made by another process (the
// preview host): the same things its boot does over the files, kind by kind, so a runner that
// is told of a change ends where a fresh boot would. Every reaction is an idempotent re-read,
// so being told twice is harmless. The reactions run one at a time, each on its own, and the
// answer says which kinds were taken, which threw and with what, and what was merely noted -
// the drift a reconcile only logs, a file the registry skipped - as boot would have logged it.
import * as store from './store.js';
import { registry as apis } from './apis.js';
import { scheduler } from './jobs/index.js';
import { reconcile, reconcileSystem } from './db.js';
import { clearCache } from './runner.js';

let chain = Promise.resolve();

// Serialised: two changes told at once never interleave a refresh.
export function applyChanges(change) {
  const run = chain.catch(() => {}).then(() => applyNow(change));
  chain = run.catch(() => {});
  return run;
}

function syncLines(sync, warnings) {
  for (const name of sync.created) console.log(`[db] created table ${name}`);
  for (const column of sync.added) console.log(`[db] added column ${column}`);
  for (const seed of sync.seeded) console.log(`[db] seeded ${seed}`);
  for (const warning of sync.warnings) {
    console.warn(`[db] ${warning}`);
    warnings.push(`db: ${warning}`);
  }
}

async function seedIfSignedIn(warnings) {
  const settings = await store.readProject();
  if (!settings.auth.enabled) return;
  syncLines(reconcileSystem(), warnings);
  const { applyUsersSeedLogged } = await import('./auth/seed.js');
  applyUsersSeedLogged();
}

async function applyNow({ kinds = [], authTurnedOn = false } = {}) {
  const applied = [];
  const failed = [];
  const warnings = [];
  const attempt = async (kind, fn) => {
    try {
      await fn();
      applied.push(kind);
    } catch (err) {
      console.error(`[changes] ${kind}: ${err.message}`);
      failed.push({ kind, error: err.message });
    }
  };
  for (const kind of new Set(Array.isArray(kinds) ? kinds : [])) {
    if (kind === 'apis') {
      await attempt(kind, () => apis.refresh({ warn: (msg) => warnings.push(`apis: ${msg}`) }));
    } else if (kind === 'jobs') {
      await attempt(kind, () => scheduler.refresh());
    } else if (kind === 'project') {
      // The settings are swapped whole, never emptied and re-read: a request guard reads them.
      await attempt(kind, async () => {
        await store.reloadProject();
        if (authTurnedOn) await seedIfSignedIn(warnings);
      });
    } else if (kind === 'import') {
      await attempt(kind, async () => {
        // Everything cached about the old project is stale now.
        clearCache();
        await store.reloadProject();
        syncLines(reconcile(), warnings);
        await seedIfSignedIn(warnings);
        await apis.refresh({ warn: (msg) => warnings.push(`apis: ${msg}`) });
        await scheduler.refresh();
      });
    } else {
      // Forms, scripts, workflows, notes, modules, pictures: read from the files when used.
      applied.push(kind);
    }
  }
  return { applied, failed, warnings };
}
