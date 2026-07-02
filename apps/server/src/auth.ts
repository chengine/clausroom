/**
 * Bearer-token auth middleware and room membership guards.
 *
 * Only session (arst_) and bridge (arbt_) tokens authenticate REST/WS calls;
 * invite (arit_) tokens are usable exclusively at POST /api/auth/login.
 * Raw tokens are NEVER stored or logged — only sha256Hex(token) is compared.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { sha256Hex } from '@clausroom/protocol';
import { forbidden, notFound, unauthorized } from './errors.js';
import { nowIso, type ParticipantRow, type RoomRow, type Store, type TokenRow, type UserRow } from './db.js';

const LAST_USED_THROTTLE_MS = 60_000;

export interface AuthContext {
  user: UserRow;
  tokenKind: 'session' | 'bridge';
  tokenRow: TokenRow;
}

export interface RoomContext {
  room: RoomRow;
  participant: ParticipantRow;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
      roomCtx?: RoomContext;
    }
  }
}

/** req.auth, guaranteed present after authMiddleware ran. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/** req.roomCtx, guaranteed present after roomGuard ran. */
export function getRoomCtx(req: Request): RoomContext {
  if (!req.roomCtx) throw notFound('Room not found.');
  return req.roomCtx;
}

/**
 * Resolve a raw bearer token string to { user, tokenKind, tokenRow } or null.
 * Shared by the HTTP middleware and the WS upgrade handler.
 */
export function resolveApiToken(store: Store, rawToken: string): AuthContext | null {
  if (!rawToken) return null;
  const row = store.getTokenByHash(sha256Hex(rawToken));
  if (!row || row.revoked_at !== null) return null;
  if (row.kind !== 'session' && row.kind !== 'bridge') return null;
  const user = store.getUserById(row.user_id);
  if (!user) return null;
  // Best-effort last_used_at, throttled to ~1/min.
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= LAST_USED_THROTTLE_MS) {
    try {
      store.touchToken(row.id, new Date(now).toISOString());
    } catch {
      // best-effort only
    }
  }
  return { user, tokenKind: row.kind, tokenRow: row };
}

/** Express middleware: require a valid session or bridge bearer token. */
export function authMiddleware(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return next(unauthorized());
    const auth = resolveApiToken(store, header.slice('Bearer '.length).trim());
    if (!auth) return next(unauthorized());
    req.auth = auth;
    next();
  };
}

/**
 * Room-scoped guard for every /api/rooms/:id/** route: the room must exist and
 * the caller must be a participant (otherwise 404, hiding room existence).
 * A bridge token used against any room other than its own -> 403 forbidden.
 */
export function roomGuard(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const auth = getAuth(req);
    const roomId = req.params.id;
    if (!roomId) return next(notFound('Room not found.'));
    const room = store.getRoom(roomId);
    if (!room) return next(notFound('Room not found.'));
    if (auth.tokenKind === 'bridge' && auth.tokenRow.room_id !== room.id) {
      return next(forbidden('This bridge token is scoped to a different room.'));
    }
    const participant = store.getParticipant(room.id, auth.user.id);
    if (!participant) return next(notFound('Room not found.'));
    req.roomCtx = { room, participant };
    next();
  };
}

export { nowIso };
