/**
 * Request-level rules: typed HTTP errors, bearer-token auth, the room
 * membership guard, the message body seatbelts, and the one path that accepts a
 * message (insert, broadcast, log).
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z, ZodTypeAny } from 'zod';
import type { ErrorCode, Message, Participant, Room, User } from '@clausroom/protocol';
import { LIMITS, REDACTION_PATTERNS, sha256Hex } from '@clausroom/protocol';
import type { ApprovalRow, NewMessage, Store, TokenRow } from './db.js';
import type { Hub } from './ws.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  validation: 422,
  inline_blob: 422,
  turn_limit: 429,
  agents_paused: 403,
  participant_paused: 403,
  approval_required: 403,
};

export class HttpError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = STATUS[code];
  }
}

export const fail = (code: ErrorCode, message: string): HttpError => new HttpError(code, message);

/** Room existence is hidden from non-participants: everything is a 404. */
export const noRoom = (): HttpError => fail('not_found', 'Room not found.');

/** Wrap an async handler so a rejection reaches the express error handler. */
export function handler(
  fn: (req: Request, res: Response) => Promise<void> | void,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

/** Validate external input, or throw 422 listing every issue. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data as z.output<S>;
  throw fail(
    'validation',
    result.error.issues
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; '),
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface Caller {
  user: User;
  /** 'session' is a human's browser; 'bridge' is an agent, scoped to one room. */
  tokenKind: 'session' | 'bridge';
  token: TokenRow;
  /** Present on every /api/rooms/:id route. */
  room?: Room;
  participant?: Participant;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      caller?: Caller;
    }
  }
}

/** The caller, guaranteed present after `auth` ran. */
export function caller(req: Request): Caller {
  if (!req.caller) throw fail('unauthorized', 'Missing or invalid token.');
  return req.caller;
}

/** The room context, guaranteed present after `inRoom` ran. */
export function roomOf(req: Request): { room: Room; participant: Participant; me: Caller } {
  const me = caller(req);
  if (!me.room || !me.participant) throw noRoom();
  return { room: me.room, participant: me.participant, me };
}

/** Resolve a raw bearer token. Shared by the HTTP middleware and the WS upgrade. */
export function resolveToken(store: Store, raw: string): Caller | null {
  if (!raw) return null;
  const token = store.token(sha256Hex(raw));
  if (!token || token.revoked_at !== null) return null;
  if (token.kind !== 'session' && token.kind !== 'bridge') return null;
  const user = store.user(token.user_id);
  return user ? { user, tokenKind: token.kind, token } : null;
}

/** Require a session or bridge token on every /api route except login. */
export function auth(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const resolved = header.startsWith('Bearer ')
      ? resolveToken(store, header.slice(7).trim())
      : null;
    if (!resolved) return next(fail('unauthorized', 'Missing or invalid token.'));
    req.caller = resolved;
    next();
  };
}

/** Require that :id is a room the caller participates in. */
export function inRoom(store: Store): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const me = caller(req);
    const room = req.params.id ? store.room(req.params.id) : undefined;
    if (!room) return next(noRoom());
    if (me.tokenKind === 'bridge' && me.token.room_id !== room.id) {
      return next(fail('forbidden', 'This bridge token belongs to a different room.'));
    }
    const participant = store.participant(room.id, me.user.id);
    if (!participant) return next(noRoom());
    me.room = room;
    me.participant = participant;
    next();
  };
}

// ---------------------------------------------------------------------------
// Message seatbelts
// ---------------------------------------------------------------------------

const INLINE_BLOB = /[A-Za-z0-9+/=]{2000,}/;

/** A long base64 run means someone pasted a file into a message. */
export function hasInlineBlob(body: string): boolean {
  return INLINE_BLOB.test(body);
}

const REDACTIONS = REDACTION_PATTERNS.map((src) => new RegExp(src, 'g'));

/**
 * Replace anything that looks like a credential with `[redacted-secret]`,
 * applied to every message body before it is stored or broadcast. The original
 * never persists. A seatbelt, not a guarantee.
 */
export function redact(body: string): string {
  return REDACTIONS.reduce((text, re) => text.replace(re, '[redacted-secret]'), body);
}

/**
 * A pending approval older than the TTL reads (and persists) as expired. There
 * is no sweep: expiry is applied wherever an approval is read.
 */
export function withExpiry(store: Store, row: ApprovalRow): ApprovalRow {
  if (row.status !== 'pending') return row;
  if (Date.now() - Date.parse(row.created_at) <= LIMITS.APPROVAL_TTL_MS) return row;
  store.setApprovalStatus(row.id, 'expired');
  return { ...row, status: 'expired' };
}

/** Drop the server-only column before an approval goes on the wire. */
export function wire(row: ApprovalRow): Omit<ApprovalRow, 'consumed_at'> {
  const { consumed_at: _drop, ...approval } = row;
  return approval;
}

// ---------------------------------------------------------------------------
// The one path that accepts a message
// ---------------------------------------------------------------------------

/**
 * Insert, broadcast, and log one message. Callers that must write atomically
 * with something else (an artifact row) insert inside their own transaction and
 * call `publish` afterwards.
 */
export function post(store: Store, hub: Hub, input: NewMessage): Message {
  const message = store.addMessage(input);
  publish(hub, message);
  return message;
}

export function publish(hub: Hub, message: Message): void {
  hub.send(message.room_id, { type: 'message_created', message });
  process.stdout.write(`MSG ${message.room_id} ${message.sender.id} ${message.message_type}\n`);
}

/** A system_event from the System user, announcing something the server did. */
export function announce(store: Store, hub: Hub, roomId: string, text: string): void {
  const system = store.systemUser();
  if (!system) return;
  post(store, hub, {
    room_id: roomId,
    sender: system,
    message_type: 'system_event',
    body_markdown: text,
  });
}
