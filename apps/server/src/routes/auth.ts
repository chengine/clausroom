/**
 * POST /api/auth/login — exchange a single-use invite token for a session token.
 * GET  /api/me         — caller identity + rooms they participate in.
 */
import { Router } from 'express';
import {
  LoginRequestSchema,
  genId,
  newSessionToken,
  sha256Hex,
} from '@clausroom/protocol';
import { unauthorized } from '../errors.js';
import { authMiddleware, getAuth } from '../auth.js';
import { nowIso, toRoom, toUser, type Store } from '../db.js';
import type { ServerConfig } from '../env.js';
import { h, parse } from './util.js';

export function authRoutes(store: Store, config: ServerConfig): Router {
  const router = Router();

  // No Authorization header required.
  router.post(
    '/auth/login',
    h(async (req, res) => {
      const body = parse(LoginRequestSchema, req.body);
      const row = store.getTokenByHash(sha256Hex(body.invite_token));
      if (!row || row.kind !== 'invite' || row.revoked_at !== null || row.used_at !== null) {
        throw unauthorized('Unknown, revoked, or already-used invite token.');
      }
      const user = store.getUserById(row.user_id);
      if (!user) throw unauthorized('Unknown, revoked, or already-used invite token.');

      const sessionToken = newSessionToken();
      const now = nowIso();
      store.transaction(() => {
        store.markInviteUsed(row.id, now);
        store.insertToken({
          id: genId('tok'),
          kind: 'session',
          token_hash: sha256Hex(sessionToken),
          user_id: user.id,
          room_id: null,
          name: 'session',
          created_at: now,
          last_used_at: null,
          used_at: null,
          revoked_at: null,
        });
      });
      res.status(200).json({ session_token: sessionToken, user: toUser(user) });
    }),
  );

  router.get(
    '/me',
    authMiddleware(store, config.sessionTtlDays),
    h(async (req, res) => {
      const auth = getAuth(req);
      const rooms = store.listRoomsForUser(auth.user.id);
      res.status(200).json({
        user: toUser(auth.user),
        rooms: rooms.map(({ room, role }) => ({ room: toRoom(room, config), my_role: role })),
      });
    }),
  );

  return router;
}
