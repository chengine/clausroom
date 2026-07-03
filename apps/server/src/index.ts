/**
 * clausroom server entry point: env parsing, first-run bootstrap, express app,
 * WebSocket upgrade, listen. Binding stdout lines (docs/API-CONTRACT.md §2/§14):
 *
 *   CLAUSROOM_BOOTSTRAP_INVITE <arit_ token>   (first run only)
 *   CLAUSROOM_RECOVERY_INVITE <arit_ token>    (only when an admin human is locked out, §2)
 *   CLAUSROOM_LISTENING <actual-port>          (every run, once listening)
 *   MSG <room_id> <sender_id> <message_type>   (every accepted message)
 *
 * Raw tokens are never logged except the one-time bootstrap/recovery invite lines.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { genId, newInviteToken, sha256Hex } from '@clausroom/protocol';
import { loadConfig } from './env.js';
import { HttpError, notFound, tooLarge, validation } from './errors.js';
import { nowIso, Store, type UserRow } from './db.js';
import { authMiddleware, isSessionExpired } from './auth.js';
import { MessageRateLimiter } from './policy.js';
import { WsHub } from './ws.js';
import { startRetentionSweep } from './retention.js';
import { mountStatic, resolveWebDist } from './static.js';
import { authRoutes } from './routes/auth.js';
import { roomRoutes } from './routes/rooms.js';
import { participantRoutes } from './routes/participants.js';
import { pauseRoutes } from './routes/pause.js';
import { summaryRoutes } from './routes/summary.js';
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

/**
 * Owner-lockout recovery (docs/API-CONTRACT.md §2): if an admin human (the
 * bootstrap Host) no longer holds ANY usable credential — every invite used or
 * revoked, every session token revoked or TTL-expired — they could never get
 * back in: minting a fresh invite requires an authenticated owner session,
 * i.e. exactly what they lost. On startup, detect that state and mint a fresh
 * single-use invite per locked-out admin, printed once like the bootstrap
 * line. Restarting the server is the in-band recovery path.
 */
function recoverAdminAccess(
  store: Store,
  sessionTtlDays: number,
): Array<{ user: UserRow; invite: string }> {
  const recovered: Array<{ user: UserRow; invite: string }> = [];
  const nowMs = Date.now();
  for (const admin of store.getAdminHumans()) {
    const usable = store.listUserAuthTokens(admin.id).some((t) =>
      t.kind === 'invite' ? t.used_at === null : !isSessionExpired(t, sessionTtlDays, nowMs),
    );
    if (usable) continue;
    const invite = newInviteToken();
    store.insertToken({
      id: genId('tok'),
      kind: 'invite',
      token_hash: sha256Hex(invite),
      user_id: admin.id,
      room_id: null,
      name: 'recovery',
      created_at: nowIso(),
      last_used_at: null,
      used_at: null,
      revoked_at: null,
    });
    recovered.push({ user: admin, invite });
  }
  return recovered;
}

function main(): void {
  const config = loadConfig(process.env);

  fs.mkdirSync(path.resolve(config.artifactDir), { recursive: true });
  const store = new Store(config.dbPath);
  const bootstrapInvite = bootstrap(store);
  if (bootstrapInvite) {
    console.log(`CLAUSROOM_BOOTSTRAP_INVITE ${bootstrapInvite}`);
  } else {
    for (const { user, invite } of recoverAdminAccess(store, config.sessionTtlDays)) {
      console.log(`CLAUSROOM_RECOVERY_INVITE ${invite}`);
      console.error(
        `[clausroom] every credential of admin "${user.display_name}" (${user.id}) was ` +
          'expired, used, or revoked — minted the fresh single-use invite above; ' +
          'log in with it via the web UI.',
      );
    }
  }

  const hub = new WsHub(store, config.sessionTtlDays);
  const rateLimiter = new MessageRateLimiter();
  // Retention sweep: once on boot, then every 10 minutes (unref()'d interval).
  const stopRetentionSweep = startRetentionSweep(store);

  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  // JSON body limit: 1 MB (413 too_large — mapped in the error handler).
  app.use(express.json({ limit: 1048576 }));

  // /api/auth/login (no auth) + /api/me (self-authenticated).
  app.use('/api', authRoutes(store, config.sessionTtlDays));
  // Everything else under /api requires a session or bridge token.
  app.use('/api', authMiddleware(store, config.sessionTtlDays));
  app.use('/api', roomRoutes(store, config));
  app.use('/api', participantRoutes(store));
  app.use('/api', pauseRoutes(store, hub));
  app.use('/api', summaryRoutes(store, hub));
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

  // Graceful shutdown: stop the sweep, close ws server, http server, then the database.
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopRetentionSweep();
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
