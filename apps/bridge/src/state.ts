/**
 * Local bridge state: the last-read message cursor per (room, agent identity),
 * persisted at ~/.clausroom/state/<room_id>__<agent_user_id>.json, plus
 * downloads-directory resolution. The cursor is keyed by identity as well as
 * room so two bridges on the same machine joined to the same room never
 * clobber each other's read cursor.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { BridgeConfig } from './config.js';

const StateFileSchema = z.object({
  last_read_message_id: z.string().nullable().default(null),
  /** created_at of that message; used so the cursor only ever moves forward. */
  last_read_created_at: z.string().nullable().default(null),
});

export type CursorState = z.infer<typeof StateFileSchema>;

function clausroomDir(): string {
  return path.join(os.homedir(), '.clausroom');
}

/**
 * Cursor scope key: room id + agent user id. The cursor is semantically
 * per-agent ("YOUR last-read cursor"), so it must not be shared between two
 * bridge processes (different arbt_ tokens) pointed at the same room.
 */
export function cursorScope(roomId: string, agentUserId: string): string {
  return `${roomId}__${agentUserId}`;
}

function stateFilePath(scope: string): string {
  // Scopes are built from room/user ids (<prefix>_<24 hex>), but sanitize
  // defensively since the room id came from a config file.
  const safe = scope.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(clausroomDir(), 'state', `${safe}.json`);
}

/** Load the persisted cursor for a scope; missing/corrupt files yield an empty cursor. */
export function loadCursor(scope: string): CursorState {
  try {
    const raw = fs.readFileSync(stateFilePath(scope), 'utf8');
    const parsed = StateFileSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // fall through to the empty cursor
  }
  return { last_read_message_id: null, last_read_created_at: null };
}

/** Persist the cursor for a scope (creates ~/.clausroom/state if needed). */
export function saveCursor(scope: string, state: CursorState): void {
  const file = stateFilePath(scope);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Unique tmp name: concurrent bridge processes must never race on the same
  // tmp file (writeFileSync/renameSync interleaving would throw ENOENT).
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Advance the cursor only if the candidate message is newer than the stored
 * one, using the room's total order (created_at, id). Returns the state that
 * is now persisted.
 */
export function advanceCursor(
  scope: string,
  current: CursorState,
  candidate: { id: string; created_at: string },
): CursorState {
  const cur: [string, string] = [current.last_read_created_at ?? '', current.last_read_message_id ?? ''];
  const cand: [string, string] = [candidate.created_at, candidate.id];
  const isNewer =
    cand[0] > cur[0] || (cand[0] === cur[0] && cand[1] > cur[1]);
  if (!isNewer) return current;
  const next: CursorState = {
    last_read_message_id: candidate.id,
    last_read_created_at: candidate.created_at,
  };
  saveCursor(scope, next);
  return next;
}

/**
 * Downloads directory for this room: filesystem.downloads_dir from the config
 * if set, else ~/.clausroom/downloads/<room_id>. Never anywhere else.
 */
export function resolveDownloadsDir(cfg: BridgeConfig): string {
  if (cfg.filesystem.downloads_dir) return cfg.filesystem.downloads_dir;
  const safe = cfg.room.room_id.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(clausroomDir(), 'downloads', safe);
}
