import { createHash, randomBytes } from 'node:crypto';

/**
 * Entity id prefixes. Ids look like `user_a1b2c3...` — prefix + '_' + 24 hex chars.
 */
export const ID_PREFIXES = ['user', 'room', 'msg', 'art', 'apr', 'tok'] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

/**
 * Generate a new entity id: `<prefix>_<24 hex chars>` (12 random bytes).
 *
 * Examples: `user_9f8a...`, `room_...`, `msg_...`, `art_...`, `apr_...`, `tok_...`
 */
export function genId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/** Single-use invite token (exchanged for a session token at login): `arit_` + 32 hex chars. */
export function newInviteToken(): string {
  return `arit_${randomBytes(16).toString('hex')}`;
}

/** Human session token (returned by POST /api/auth/login): `arst_` + 32 hex chars. */
export function newSessionToken(): string {
  return `arst_${randomBytes(16).toString('hex')}`;
}

/** Agent bridge token (room-scoped, used by apps/bridge): `arbt_` + 32 hex chars. */
export function newBridgeToken(): string {
  return `arbt_${randomBytes(16).toString('hex')}`;
}

/**
 * Lowercase hex SHA-256 of a string or byte buffer.
 * The server stores ONLY sha256Hex(token) — never raw tokens.
 * Also used for artifact content hashes.
 */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}
