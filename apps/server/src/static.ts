/**
 * Static serving of the built web UI with SPA fallback (docs/API-CONTRACT.md §9).
 *
 * The dist path is anchored on this package's directory so it resolves both
 * when running from src via tsx (apps/server/src -> apps/server) and from the
 * compiled dist via node (apps/server/dist -> apps/server). Overridable with
 * AGENT_ROOM_WEB_DIST.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';

const INFO_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>clausroom</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto;">
<h1>clausroom server is running</h1>
<p>The web UI is not built yet &mdash; run <code>npm run build -w @clausroom/web</code>
and reload this page. The REST API is available under <code>/api</code> and the
WebSocket endpoint at <code>/ws</code>.</p>
</body>
</html>
`;

/** Resolve the web dist directory (env override wins). */
export function resolveWebDist(override?: string): string {
  if (override) return path.resolve(override);
  // <apps/server>/(src|dist)/static.* -> package dir -> ../web/dist
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageDir = path.resolve(here, '..');
  return path.resolve(packageDir, '..', 'web', 'dist');
}

/**
 * Mount static file serving + SPA fallback. Any GET whose path does not start
 * with /api, /ws, or /healthz and matches no static file returns index.html;
 * if the dist is missing, a small inline info page is served instead.
 */
export function mountStatic(app: Express, webDist: string): void {
  app.use(express.static(webDist, { index: 'index.html', fallthrough: true }));
  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/ws') ||
      req.path.startsWith('/healthz')
    ) {
      return next();
    }
    const indexPath = path.join(webDist, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
      return;
    }
    res.status(200).type('html').send(INFO_PAGE);
  });
}
