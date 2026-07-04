/**
 * Bridge join blob codec (onboarding v2). A BridgeJoinBlob is serialized as
 * base64url(JSON), NO padding, for the `clausroom-bridge join <blob>` command and
 * the POST /api/rooms/:id/my-agent `join_command`. See docs/API-CONTRACT.md §13.
 *
 * SECURITY INVARIANT: the blob carries CONNECTION info plus the recipient's OWN
 * bridge token only — never local security config. `clausroom-bridge join` writes
 * bridge.toml with safe local defaults (roots chosen by the joining user).
 */

import { Buffer } from 'node:buffer';
import { BridgeJoinBlobSchema, type BridgeJoinBlob } from './schemas.js';

/**
 * Encode a BridgeJoinBlob to a base64url (no padding) string. The blob is
 * validated and normalized (e.g. server_url trailing slashes stripped) first;
 * invalid input throws a ZodError.
 */
export function encodeJoinBlob(blob: BridgeJoinBlob): string {
  const validated = BridgeJoinBlobSchema.parse(blob);
  return Buffer.from(JSON.stringify(validated), 'utf8').toString('base64url');
}

/**
 * Decode a base64url join blob back to a validated BridgeJoinBlob. Throws a plain
 * Error if the input is not valid base64url JSON, or a ZodError if the decoded
 * object fails BridgeJoinBlobSchema. Accepts input with or without base64url
 * padding and tolerates surrounding whitespace.
 */
export function decodeJoinBlob(encoded: string): BridgeJoinBlob {
  const json = Buffer.from(encoded.trim(), 'base64url').toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('Invalid join blob: decoded bytes are not valid JSON.');
  }
  return BridgeJoinBlobSchema.parse(parsed);
}
