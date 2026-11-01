// The static files every process serves for any Host: this package's public/ (the runtime the
// browser needs, the shells' styles), and Tabulator, Chart.js and the Lucide sprite straight
// out of node_modules; there is no build step in this project. The designer adds its own
// public/ and Monaco through the options. The Data Grid widget loads Tabulator on demand, so
// forms without one never fetch it; the sprite is fetched once by the first icon that references
// it. Chart.js imports its colour helper by package name, which the pages map with an import map.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimePublic = path.join(packageRoot, 'public');

// Where an installed package lives: the nearest node_modules up from `from` that holds it. Some
// of these packages restrict their subpaths with an exports map, so their folders are found on
// disk rather than resolved.
export function packageDir(name, from = packageRoot) {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Package "${name}" is not installed near ${from}.`);
    dir = parent;
  }
}

// `vendors`: extra { route: dir } served under /vendor/<route>; `publicDirs`: extra folders
// served at the root before this package's own.
export function mountStatic(app, { index = false, vendors = {}, publicDirs = [] } = {}) {
  for (const [route, dir] of Object.entries(vendors)) app.use(`/vendor/${route}`, express.static(dir));
  app.use('/vendor/tabulator', express.static(path.join(packageDir('tabulator-tables'), 'dist')));
  app.use('/vendor/lucide', express.static(packageDir('lucide-static')));
  app.use('/vendor/chartjs', express.static(path.join(packageDir('chart.js'), 'dist')));
  app.use('/vendor/leaflet', express.static(path.join(packageDir('leaflet'), 'dist')));
  app.use('/vendor/kurkle-color', express.static(path.join(packageDir('@kurkle/color'), 'dist')));
  for (const dir of publicDirs) app.use(express.static(dir, { index }));
  app.use(express.static(runtimePublic, { index }));
}
