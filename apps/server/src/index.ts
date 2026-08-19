#!/usr/bin/env node
/**
 * The room server. Loopback only, one SQLite file, one data directory.
 *
 *   node dist/index.js [--port 3000] [--data ./data]
 *
 * Three lines on stdout are meant to be read by a program:
 *   CLAUSROOM_INVITE <arit_…>     once per boot, for the owner's browser
 *   CLAUSROOM_LISTENING <port>    once listening
 *   MSG <room> <sender> <type>    per accepted message
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { genId, newToken, sha256Hex } from '@clausroom/protocol';
import { Store } from './db.js';
import { HttpError, fail } from './room.js';
import { routes } from './routes.js';
import { Hub } from './ws.js';

const CSP =
  "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

const NOT_BUILT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>clausroom</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto">
<h1>clausroom is running</h1><p>The web UI is not built yet — run <code>npm run build</code>
and reload.</p></body></html>
`;

/** `--port`, `--data`, `--owner`, and nothing else. */
function options(argv: string[]): { port: number; data: string; owner: string } {
  let port = 3000;
  let data = './data';
  let owner = 'Host';
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${argv[i]} needs a value`);
    else if (argv[i] === '--port') port = Number(value);
    else if (argv[i] === '--data') data = value;
    else if (argv[i] === '--owner') owner = value;
    else throw new Error('usage: clausroom-server [--port <n>] [--data <dir>] [--owner <name>]');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`--port must be an integer from 0 to 65535 (got ${port})`);
  }
  return { port, data: path.resolve(data.replace(/^~(?=$|\/)/, os.homedir())), owner };
}

/**
 * Make sure the owner and the System author exist, name the owner from the
 * config, then mint them a fresh single-use invite. Minting unconditionally on
 * every boot is what keeps the launcher stateless: there is no cached session to
 * expire and no way to lock yourself out of your own room.
 */
function bootInvite(store: Store, ownerName: string): string {
  const invite = newToken('invite');
  store.transaction(() => {
    const existing = store.ownerUser();
    const owner =
      existing ??
      store.addUser({
        id: genId('user'),
        display_name: ownerName,
        kind: 'human',
        owner_user_id: null,
      });
    if (!existing) {
      store.addUser({
        id: genId('user'),
        display_name: 'System',
        kind: 'system',
        owner_user_id: null,
      });
    } else if (existing.display_name !== ownerName) {
      store.rename(existing.id, ownerName);
    }
    store.addToken('invite', sha256Hex(invite), owner.id, null);
  });
  return invite;
}

/** The built web UI, next to this package whether running from src or dist. */
function webDist(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
}

function main(): void {
  const { port, data, owner } = options(process.argv.slice(2));
  fs.mkdirSync(data, { recursive: true });

  const store = new Store(path.join(data, 'clausroom.sqlite'));
  process.stdout.write(`CLAUSROOM_INVITE ${bootInvite(store, owner)}\n`);

  const hub = new Hub(store);
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(express.json({ limit: 1048576 }));
  app.use('/api', routes(store, hub, data));
  app.use('/api', (_req, _res, next: NextFunction) => next(fail('not_found', 'Unknown API route.')));

  // The web UI, with an SPA fallback for client-side routes.
  const dist = webDist();
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (/^\/(api|ws|healthz)/.test(req.path)) return next();
    const index = path.join(dist, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else res.type('html').send(NOT_BUILT);
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return res.destroy();
    const mapped =
      err instanceof HttpError
        ? err
        : err instanceof multer.MulterError
          ? fail(
              err.code === 'LIMIT_FILE_SIZE' ? 'too_large' : 'validation',
              err.code === 'LIMIT_FILE_SIZE'
                ? 'That upload is over the size limit.'
                : `Invalid upload: ${err.message}`,
            )
          : isBodyError(err, 'entity.too.large')
            ? fail('too_large', 'The request body is over the 1 MB limit.')
            : isBodyError(err, 'entity.parse.failed')
              ? fail('validation', 'The request body is not valid JSON.')
              : null;
    if (!mapped) console.error('[clausroom] unhandled error:', err);
    const status = mapped?.status ?? 500;
    const code = mapped?.code ?? 'validation';
    const message = mapped?.message ?? 'Internal server error.';
    res.status(status).json({ error: { code, message } });
  });

  const server = http.createServer(app);
  hub.attach(server);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write(
      `CLAUSROOM_LISTENING ${address && typeof address === 'object' ? address.port : port}\n`,
    );
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    hub.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // A lingering connection must not keep the process alive forever.
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function isBodyError(err: unknown, type: string): boolean {
  return typeof err === 'object' && err !== null && (err as { type?: unknown }).type === type;
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
