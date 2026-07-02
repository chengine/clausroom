/**
 * clausroom server entry point: env parsing, first-run bootstrap, express app,
 * WebSocket upgrade, listen. Binding stdout lines (docs/API-CONTRACT.md §2/§14):
 *
 *   CLAUSROOM_BOOTSTRAP_INVITE <arit_ token>   (first run only)
 *   CLAUSROOM_LISTENING <actual-port>          (every run, once listening)
 *   MSG <room_id> <sender_id> <message_type>   (every accepted message)
 *
 * Raw tokens are never logged except the one-time bootstrap invite line.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { genId, newInviteToken, sha256Hex } from '@clausroom/protocol';
import { loadConfig } from './env.js';
import { HttpError, notFound, tooLarge, validation } from './errors.js';
import { nowIso, Store } from './db.js';
import { authMiddleware } from './auth.js';
import { MessageRateLimiter } from './policy.js';
import { WsHub } from './ws.js';
import { mountStatic, resolveWebDist } from './static.js';
import { authRoutes } from './routes/auth.js';
import { roomRoutes } from './routes/rooms.js';
import { participantRoutes } from './routes/participants.js';
import { pauseRoutes } from './routes/pause.js';
import { messageRoutes } from './routes/messages.js';
import { artifactRoutes } from './routes/artifacts.js';
import { approvalRoutes } from './routes/approvals.js';
import { exportRoutes } from './routes/export.js';

/**
 * First-run bootstrap: with an empty users table, create the admin "Host"
 * human, the singleton "System" user, and mint a one-time invite for Host.
 * Returns the raw invite token (to be printed once) or null on later runs.
 */
function bootstrap(store: Store): string | null {
  if (store.countUsers() > 0) return null;
  const now = nowIso();
  const hostId = genId('user');
  const inviteToken = newInviteToken();
  store.transaction(() => {
    store.insertUser({
      id: hostId,
      display_name: 'Host',
      email: null,
      kind: 'human',
      is_admin: 1,
      owner_user_id: null,
      created_at: now,
    });
    store.insertUser({
      id: genId('user'),
      display_name: 'System',
      email: null,
      kind: 'system',
      is_admin: 0,
      owner_user_id: null,
      created_at: now,
    });
    store.insertToken({
      id: genId('tok'),
      kind: 'invite',
      token_hash: sha256Hex(inviteToken),
      user_id: hostId,
      room_id: null,
      name: 'bootstrap',
      created_at: now,
      last_used_at: null,
      used_at: null,
      revoked_at: null,
    });
  });
  return inviteToken;
}

function main(): void {
  const config = loadConfig(process.env);

  fs.mkdirSync(path.resolve(config.artifactDir), { recursive: true });
  const store = new Store(config.dbPath);
  const bootstrapInvite = bootstrap(store);
  if (bootstrapInvite) {
    console.log(`CLAUSROOM_BOOTSTRAP_INVITE ${bootstrapInvite}`);
  }

  const hub = new WsHub(store);
  const rateLimiter = new MessageRateLimiter();

  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // JSON body limit: 1 MB (413 too_large — mapped in the error handler).
  app.use(express.json({ limit: 1048576 }));

  // /api/auth/login (no auth) + /api/me (self-authenticated).
  app.use('/api', authRoutes(store));
  // Everything else under /api requires a session or bridge token.
  app.use('/api', authMiddleware(store));
  app.use('/api', roomRoutes(store, config));
  app.use('/api', participantRoutes(store));
  app.use('/api', pauseRoutes(store, hub));
  app.use('/api', messageRoutes(store, hub, config, rateLimiter));
  app.use('/api', artifactRoutes(store, hub, config));
  app.use('/api', approvalRoutes(store, hub));
  app.use('/api', exportRoutes(store));

  // Unknown /api routes -> 404 ApiError envelope.
  app.use('/api', (_req: Request, _res: Response, next: NextFunction) => {
    next(notFound('Unknown API route.'));
  });

  // Static web UI with SPA fallback (or inline info page when not built).
  mountStatic(app, resolveWebDist(config.webDist));

  // Error handler: every non-2xx body is the binding ApiError envelope.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    let httpError: HttpError;
    if (err instanceof HttpError) {
      httpError = err;
    } else if (err instanceof multer.MulterError) {
      httpError =
        err.code === 'LIMIT_FILE_SIZE'
          ? tooLarge('Upload exceeds the maximum allowed size.')
          : validation(`Invalid multipart upload: ${err.message}`);
    } else if (isBodyParserError(err, 'entity.too.large')) {
      httpError = tooLarge('JSON body exceeds the 1 MB limit.');
    } else if (isBodyParserError(err, 'entity.parse.failed')) {
      httpError = validation('Request body is not valid JSON.');
    } else {
      console.error('[clausroom] unhandled error:', err);
      httpError = new HttpError(500, 'validation', 'Internal server error.');
    }
    res
      .status(httpError.status)
      .json({ error: { code: httpError.code, message: httpError.message } });
  });

  const server = http.createServer(app);
  hub.attach(server);

  server.listen(config.port, config.host, () => {
    const address = server.address();
    const port =
      address && typeof address === 'object' ? address.port : config.port;
    console.log(`CLAUSROOM_LISTENING ${port}`);
  });

  // Graceful shutdown: close ws server, http server, then the database.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    hub.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    // Fallback if lingering connections keep the server open.
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isBodyParserError(err: unknown, type: string): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    (err as { type?: unknown }).type === type
  );
}

main();
