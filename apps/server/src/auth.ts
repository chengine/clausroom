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

/** Bridge (and invite) last_used_at updates are best-effort, throttled to ~1/min. */
const BRIDGE_LAST_USED_THROTTLE_MS = 60_000;
/** Session sliding-renewal refreshes last_used_at at most once per hour per token. */
const SESSION_LAST_USED_THROTTLE_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Exact 401 message for an expired session token (docs/API-CONTRACT.md §1 rule 4). */
export const SESSION_EXPIRED_MESSAGE =
  'Session expired. Ask the room owner for a fresh invite/token.';

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
 * Has this session token TTL-expired (§1 rule 4)? Expiry anchor is
 * max(created_at, last_used_at); each successful use slides the window.
 * Also used by the boot-time owner-lockout recovery check (§2).
 */
export function isSessionExpired(
  row: Pick<TokenRow, 'created_at' | 'last_used_at'>,
  sessionTtlDays: number,
  nowMs: number,
): boolean {
  const anchor = Math.max(
    Date.parse(row.created_at),
    row.last_used_at ? Date.parse(row.last_used_at) : 0,
  );
  return anchor + sessionTtlDays * DAY_MS < nowMs;
}

/**
 * Resolve a raw bearer token string to { user, tokenKind, tokenRow }, the
 * sentinel 'expired' (a TTL-expired session token, §1 rule 4), or null.
 * Shared by the HTTP middleware and the WS upgrade handler.
 *
 * Session tokens expire when max(last_used_at, created_at) + sessionTtlDays
 * has passed; each successful use slides the window by refreshing
 * last_used_at (throttled to 1/hour). Invite and bridge tokens never
 * TTL-expire; bridge last_used_at updates stay best-effort (~1/min).
 */
export function resolveApiToken(
  store: Store,
  rawToken: string,
  sessionTtlDays: number,
): AuthContext | 'expired' | null {
  if (!rawToken) return null;
  const row = store.getTokenByHash(sha256Hex(rawToken));
  if (!row || row.revoked_at !== null) return null;
  if (row.kind !== 'session' && row.kind !== 'bridge') return null;
  const user = store.getUserById(row.user_id);
  if (!user) return null;
  const now = Date.now();
  if (row.kind === 'session' && isSessionExpired(row, sessionTtlDays, now)) return 'expired';
  const throttleMs =
    row.kind === 'session' ? SESSION_LAST_USED_THROTTLE_MS : BRIDGE_LAST_USED_THROTTLE_MS;
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= throttleMs) {
    try {
      store.touchToken(row.id, new Date(now).toISOString());
    } catch {
      // best-effort only
    }
  }
  return { user, tokenKind: row.kind, tokenRow: row };
}

/** Express middleware: require a valid (non-expired) session or bridge bearer token. */
export function authMiddleware(store: Store, sessionTtlDays: number): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return next(unauthorized());
    const auth = resolveApiToken(store, header.slice('Bearer '.length).trim(), sessionTtlDays);
    if (auth === 'expired') return next(unauthorized(SESSION_EXPIRED_MESSAGE));
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
