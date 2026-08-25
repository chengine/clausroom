#!/usr/bin/env node
/**
 * Bundle the CLI and room server into dist-npm. The published package also
 * carries the built browser UI; only better-sqlite3 remains external because
 * it supplies the platform-native SQLite binary.
 *
 * Equivalent shared esbuild flags:
 *   --bundle --platform=node --format=esm --target=node20
 * bufferutil / utf-8-validate are ws's OPTIONAL native accelerators: ws
 * require()s them in a try/catch and falls back to pure JS, so they stay
 * external instead of breaking the bundle.
 *
 * Banner: the entry's own '#!/usr/bin/env node' hashbang is preserved by
 * esbuild at the very top of the output; the banner adds the createRequire
 * shim that ESM bundles of CJS dependencies (ws, commander, ...) need for
 * their residual require() calls.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appsDir = path.resolve(pkgDir, '..');
const repoDir = path.resolve(appsDir, '..');
const banner = [
  '// ESM bundle of CJS deps: define require via createRequire (also lets the',
  '// external native/optional modules resolve when actually installed).',
  "import { createRequire as __clausroomCreateRequire } from 'node:module';",
  'const require = __clausroomCreateRequire(import.meta.url);',
].join('\n');
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: banner },
  sourcemap: false,
  legalComments: 'linked',
  logLevel: 'info',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(pkgDir, 'src', 'cli.ts')],
    outfile: path.join(pkgDir, 'dist-npm', 'cli.mjs'),
    external: ['bufferutil', 'utf-8-validate'],
  }),
  build({
    ...common,
    entryPoints: [path.join(appsDir, 'server', 'src', 'index.ts')],
    outfile: path.join(pkgDir, 'dist-npm', 'server.mjs'),
    external: ['better-sqlite3', 'bufferutil', 'utf-8-validate'],
  }),
]);

// `connect` serves the UI from the installed CLI, without a source checkout.
const web = path.join(appsDir, 'web', 'dist');
const bundledWeb = path.join(pkgDir, 'dist-npm', 'web');
fs.rmSync(bundledWeb, { recursive: true, force: true });
fs.cpSync(web, bundledWeb, { recursive: true });
fs.copyFileSync(path.join(repoDir, 'LICENSE'), path.join(pkgDir, 'dist-npm', 'LICENSE'));
