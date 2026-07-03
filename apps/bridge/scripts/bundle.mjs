#!/usr/bin/env node
/**
 * Bundle the bridge CLI into a single, fully self-contained ESM file at
 * dist-npm/cli.mjs. The published npm package ships ONLY this bundle (plus
 * README.md), so it must carry every runtime dependency — including the
 * workspace-local @clausroom/protocol, which is not published on its own.
 *
 * Equivalent esbuild flags:
 *   --bundle --platform=node --format=esm --target=node20
 *   --external:bufferutil --external:utf-8-validate
 * bufferutil / utf-8-validate are ws's OPTIONAL native accelerators: ws
 * require()s them in a try/catch and falls back to pure JS, so they stay
 * external instead of breaking the bundle.
 *
 * Banner: the entry's own '#!/usr/bin/env node' hashbang is preserved by
 * esbuild at the very top of the output; the banner adds the createRequire
 * shim that ESM bundles of CJS dependencies (ws, commander, ...) need for
 * their residual require() calls.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [path.join(pkgDir, 'src', 'index.ts')],
  outfile: path.join(pkgDir, 'dist-npm', 'cli.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: [
      '// ESM bundle of CJS deps: define require via createRequire (also lets the',
      '// externals bufferutil/utf-8-validate resolve when actually installed).',
      "import { createRequire as __clausroomCreateRequire } from 'node:module';",
      'const require = __clausroomCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
