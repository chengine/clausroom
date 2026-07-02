/**
 * SQLite storage layer (better-sqlite3): schema per docs/API-CONTRACT.md §11,
 * prepared-statement helpers, and row <-> protocol-type mappers.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  Message,
  Participant,
  Role,
  Room,
  User,
  UserKind,
} from '@clausroom/protocol';

/** ISO-8601 UTC timestamp with milliseconds. */
export function nowIso(): string {
  return new Date().toISOString();
}

let lastMonotonicMs = 0;

/**
 * Strictly increasing ISO-8601 UTC timestamp (process-wide). Used for message
 * `created_at` so that the room's total order `(created_at, id)` never places
 * a later insert before an earlier one: two inserts in the same millisecond
 * with random ids would otherwise be ~50% likely to invert, making the newer
 * message permanently invisible to `after`-cursor pagination.
 */
export function monotonicNowIso(): string {
  const now = Date.now();
  lastMonotonicMs = now > lastMonotonicMs ? now : lastMonotonicMs + 1;
  return new Date(lastMonotonicMs).toISOString();
}

// ---------------------------------------------------------------------------
// Row shapes (exactly the SQLite column shapes; booleans are 0/1 INTEGERs)
// ---------------------------------------------------------------------------

export interface UserRow {
  id: string;
  display_name: string;
  email: string | null;
  kind: UserKind;
  is_admin: number;
  owner_user_id: string | null;
  created_at: string;
}

export interface RoomRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  agents_paused: number;
  archived_at: string | null;
}

export interface ParticipantRow {
  room_id: string;
  user_id: string;
  role: Role;
  can_send: number;
  can_upload: number;
  paused: number;
}

export interface MessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  recipient_ids_json: string;
  message_type: string;
  body_markdown: string;
  artifact_ids_json: string;
  reply_to_message_id: string | null;
  confidence: string | null;
  created_at: string;
}

/** Message row joined with its sender's user row. */
export interface MessageJoinedRow extends MessageRow {
  sender_kind: UserKind;
  sender_display_name: string;
}

export interface ArtifactRow {
  id: string;
  room_id: string;
  uploaded_by: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  approval_id: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface ApprovalRow {
  id: string;
  room_id: string;
  requested_by: string;
  reviewer_user_id: string;
  approval_type: string;
  payload_json: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at: string | null;
  expires_at: string | null;
  /** Set when an approved artifact_upload approval is used by an upload (single-use). */
  consumed_at: string | null;
}

export interface TokenRow {
  id: string;
  kind: 'invite' | 'session' | 'bridge';
  token_hash: string;
  user_id: string;
  room_id: string | null;
  name: string;
  created_at: string;
  last_used_at: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

// ---------------------------------------------------------------------------
// Row -> protocol mappers
// ---------------------------------------------------------------------------

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    display_name: row.display_name,
    kind: row.kind,
    is_admin: row.is_admin === 1,
    owner_user_id: row.owner_user_id,
    created_at: row.created_at,
  };
}

export function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
    agents_paused: row.agents_paused === 1,
    archived_at: row.archived_at,
  };
}

export function toParticipant(row: ParticipantRow, user: UserRow): Participant {
  return {
    room_id: row.room_id,
    user_id: row.user_id,
    role: row.role,
    can_send: row.can_send === 1,
    can_upload: row.can_upload === 1,
    paused: row.paused === 1,
    user: toUser(user),
  };
}

function parseJsonArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    // fall through
  }
  return [];
}

export function toMessage(row: MessageJoinedRow): Message {
  return {
    id: row.id,
    room_id: row.room_id,
    sender: {
      id: row.sender_id,
      kind: row.sender_kind,
      display_name: row.sender_display_name,
    },
    recipient_ids: parseJsonArray(row.recipient_ids_json),
    message_type: row.message_type as Message['message_type'],
    body_markdown: row.body_markdown,
    artifact_ids: parseJsonArray(row.artifact_ids_json),
    reply_to_message_id: row.reply_to_message_id,
    confidence: (row.confidence as Message['confidence']) ?? null,
    created_at: row.created_at,
  };
}

export function toArtifact(row: ArtifactRow): Artifact {
  return {
    id: row.id,
    room_id: row.room_id,
    uploaded_by: row.uploaded_by,
    filename: row.filename,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    sha256: row.sha256,
    approval_id: row.approval_id,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

export function toApproval(row: ApprovalRow): Approval {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    // keep {}
  }
  return {
    id: row.id,
    room_id: row.room_id,
    requested_by: row.requested_by,
    reviewer_user_id: row.reviewer_user_id,
    approval_type: row.approval_type as Approval['approval_type'],
    payload,
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

// ---------------------------------------------------------------------------
// Schema (binding shape from docs/API-CONTRACT.md §11 + indexes)
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  email         TEXT,
  kind          TEXT NOT NULL CHECK (kind IN ('human','agent','bridge','system')),
  is_admin      INTEGER NOT NULL DEFAULT 0,
  owner_user_id TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL,
  agents_paused INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT
);

CREATE TABLE IF NOT EXISTS room_participants (
  room_id    TEXT NOT NULL REFERENCES rooms(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  role       TEXT NOT NULL CHECK (role IN ('owner','human','agent','observer')),
  can_send   INTEGER NOT NULL DEFAULT 1,
  can_upload INTEGER NOT NULL DEFAULT 1,
  paused     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                  TEXT PRIMARY KEY,
  room_id             TEXT NOT NULL REFERENCES rooms(id),
  sender_id           TEXT NOT NULL REFERENCES users(id),
  recipient_ids_json  TEXT NOT NULL DEFAULT '[]',
  message_type        TEXT NOT NULL,
  body_markdown       TEXT NOT NULL,
  artifact_ids_json   TEXT NOT NULL DEFAULT '[]',
  reply_to_message_id TEXT REFERENCES messages(id),
  confidence          TEXT CHECK (confidence IN ('low','medium','high')),
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  approval_id  TEXT REFERENCES approvals(id),
  created_at   TEXT NOT NULL,
  expires_at   TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  requested_by     TEXT NOT NULL REFERENCES users(id),
  reviewer_user_id TEXT NOT NULL REFERENCES users(id),
  approval_type    TEXT NOT NULL CHECK (approval_type IN ('artifact_upload','shell_command','code_edit','other')),
  payload_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  expires_at       TEXT,
  consumed_at      TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('invite','session','bridge')),
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      TEXT NOT NULL REFERENCES users(id),
  room_id      TEXT REFERENCES rooms(id),
  name         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  used_at      TEXT,
  revoked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_room_order ON messages(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_room_order ON artifacts(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_approvals_room_order ON approvals(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON room_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);
`;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const MESSAGE_JOIN_SELECT = `
  SELECT m.*, u.kind AS sender_kind, u.display_name AS sender_display_name
  FROM messages m JOIN users u ON u.id = m.sender_id
`;

export class Store {
  private readonly db: Database.Database;
  private closed = false;

  constructor(dbPath: string) {
    const resolved = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    this.db = new Database(resolved);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
    // Migration: approvals.consumed_at was added after the first release;
    // CREATE TABLE IF NOT EXISTS does not extend existing tables.
    const approvalCols = this.db.pragma('table_info(approvals)') as Array<{ name: string }>;
    if (!approvalCols.some((c) => c.name === 'consumed_at')) {
      this.db.exec('ALTER TABLE approvals ADD COLUMN consumed_at TEXT');
    }
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // --- users ---------------------------------------------------------------

  countUsers(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
    return row.n;
  }

  getUserById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  getSystemUser(): UserRow | undefined {
    return this.db
      .prepare("SELECT * FROM users WHERE kind = 'system' ORDER BY created_at ASC LIMIT 1")
      .get() as UserRow | undefined;
  }

  insertUser(row: UserRow): void {
    this.db
      .prepare(
        `INSERT INTO users (id, display_name, email, kind, is_admin, owner_user_id, created_at)
         VALUES (@id, @display_name, @email, @kind, @is_admin, @owner_user_id, @created_at)`,
      )
      .run(row);
  }

  // --- tokens --------------------------------------------------------------

  insertToken(row: TokenRow): void {
    this.db
      .prepare(
        `INSERT INTO tokens (id, kind, token_hash, user_id, room_id, name, created_at, last_used_at, used_at, revoked_at)
         VALUES (@id, @kind, @token_hash, @user_id, @room_id, @name, @created_at, @last_used_at, @used_at, @revoked_at)`,
      )
      .run(row);
  }

  getTokenByHash(tokenHash: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(tokenHash) as
      | TokenRow
      | undefined;
  }

  touchToken(id: string, ts: string): void {
    this.db.prepare('UPDATE tokens SET last_used_at = ? WHERE id = ?').run(ts, id);
  }

  markInviteUsed(id: string, ts: string): void {
    this.db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(ts, id);
  }

  /** Revoke all live invite + session tokens of a human user. */
  revokeHumanTokens(userId: string, ts: string): void {
    this.db
      .prepare(
        `UPDATE tokens SET revoked_at = ?
         WHERE user_id = ? AND kind IN ('invite','session') AND revoked_at IS NULL`,
      )
      .run(ts, userId);
  }

  /** Revoke all live bridge tokens of an agent user for one room. */
  revokeBridgeTokens(userId: string, roomId: string, ts: string): void {
    this.db
      .prepare(
        `UPDATE tokens SET revoked_at = ?
         WHERE user_id = ? AND kind = 'bridge' AND room_id = ? AND revoked_at IS NULL`,
      )
      .run(ts, userId, roomId);
  }

  // --- rooms ---------------------------------------------------------------

  insertRoom(row: RoomRow): void {
    this.db
      .prepare(
        `INSERT INTO rooms (id, name, created_by, created_at, agents_paused, archived_at)
         VALUES (@id, @name, @created_by, @created_at, @agents_paused, @archived_at)`,
      )
      .run(row);
  }

  getRoom(id: string): RoomRow | undefined {
    return this.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
  }

  setRoomAgentsPaused(roomId: string, paused: boolean): void {
    this.db
      .prepare('UPDATE rooms SET agents_paused = ? WHERE id = ?')
      .run(paused ? 1 : 0, roomId);
  }

  /** Rooms where the user is a participant, ascending by room created_at. */
  listRoomsForUser(userId: string): Array<{ room: RoomRow; role: Role }> {
    const rows = this.db
      .prepare(
        `SELECT r.*, p.role AS my_role
         FROM rooms r JOIN room_participants p ON p.room_id = r.id
         WHERE p.user_id = ?
         ORDER BY r.created_at ASC, r.id ASC`,
      )
      .all(userId) as Array<RoomRow & { my_role: Role }>;
    return rows.map((row) => {
      const { my_role, ...room } = row;
      return { room, role: my_role };
    });
  }

  // --- participants ----------------------------------------------------------

  insertParticipant(row: ParticipantRow): void {
    this.db
      .prepare(
        `INSERT INTO room_participants (room_id, user_id, role, can_send, can_upload, paused)
         VALUES (@room_id, @user_id, @role, @can_send, @can_upload, @paused)`,
      )
      .run(row);
  }

  getParticipant(roomId: string, userId: string): ParticipantRow | undefined {
    return this.db
      .prepare('SELECT * FROM room_participants WHERE room_id = ? AND user_id = ?')
      .get(roomId, userId) as ParticipantRow | undefined;
  }

  listParticipants(roomId: string): Array<{ participant: ParticipantRow; user: UserRow }> {
    const rows = this.db
      .prepare(
        `SELECT p.room_id, p.user_id, p.role, p.can_send, p.can_upload, p.paused,
                u.id AS u_id, u.display_name AS u_display_name, u.email AS u_email,
                u.kind AS u_kind, u.is_admin AS u_is_admin,
                u.owner_user_id AS u_owner_user_id, u.created_at AS u_created_at
         FROM room_participants p JOIN users u ON u.id = p.user_id
         WHERE p.room_id = ?
         ORDER BY u.created_at ASC, u.id ASC`,
      )
      .all(roomId) as Array<
      ParticipantRow & {
        u_id: string;
        u_display_name: string;
        u_email: string | null;
        u_kind: UserKind;
        u_is_admin: number;
        u_owner_user_id: string | null;
        u_created_at: string;
      }
    >;
    return rows.map((r) => ({
      participant: {
        room_id: r.room_id,
        user_id: r.user_id,
        role: r.role,
        can_send: r.can_send,
        can_upload: r.can_upload,
        paused: r.paused,
      },
      user: {
        id: r.u_id,
        display_name: r.u_display_name,
        email: r.u_email,
        kind: r.u_kind,
        is_admin: r.u_is_admin,
        owner_user_id: r.u_owner_user_id,
        created_at: r.u_created_at,
      },
    }));
  }

  setParticipantPaused(roomId: string, userId: string, paused: boolean): void {
    this.db
      .prepare('UPDATE room_participants SET paused = ? WHERE room_id = ? AND user_id = ?')
      .run(paused ? 1 : 0, roomId, userId);
  }

  // --- messages ----------------------------------------------------------------

  insertMessage(row: MessageRow): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, room_id, sender_id, recipient_ids_json, message_type, body_markdown,
                               artifact_ids_json, reply_to_message_id, confidence, created_at)
         VALUES (@id, @room_id, @sender_id, @recipient_ids_json, @message_type, @body_markdown,
                 @artifact_ids_json, @reply_to_message_id, @confidence, @created_at)`,
      )
      .run(row);
  }

  getMessageInRoom(roomId: string, messageId: string): MessageJoinedRow | undefined {
    return this.db
      .prepare(`${MESSAGE_JOIN_SELECT} WHERE m.room_id = ? AND m.id = ?`)
      .get(roomId, messageId) as MessageJoinedRow | undefined;
  }

  /** Ascending (created_at, id) page, optionally strictly after a cursor message. */
  listMessages(
    roomId: string,
    after: { created_at: string; id: string } | null,
    limit: number,
  ): MessageJoinedRow[] {
    if (after) {
      return this.db
        .prepare(
          `${MESSAGE_JOIN_SELECT}
           WHERE m.room_id = ? AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
           ORDER BY m.created_at ASC, m.id ASC LIMIT ?`,
        )
        .all(roomId, after.created_at, after.created_at, after.id, limit) as MessageJoinedRow[];
    }
    return this.db
      .prepare(`${MESSAGE_JOIN_SELECT} WHERE m.room_id = ? ORDER BY m.created_at ASC, m.id ASC LIMIT ?`)
      .all(roomId, limit) as MessageJoinedRow[];
  }

  /** Every message in the room, ascending (created_at, id) — used by export. */
  listAllMessages(roomId: string): MessageJoinedRow[] {
    return this.db
      .prepare(`${MESSAGE_JOIN_SELECT} WHERE m.room_id = ? ORDER BY m.created_at ASC, m.id ASC`)
      .all(roomId) as MessageJoinedRow[];
  }

  latestMessageId(roomId: string): string | null {
    const row = this.db
      .prepare('SELECT id FROM messages WHERE room_id = ? ORDER BY created_at DESC, id DESC LIMIT 1')
      .get(roomId) as { id: string } | undefined;
    return row ? row.id : null;
  }

  /**
   * Iterate messages newest-first (with sender kind) — used by the turn-limit
   * walk so we never load the whole room history.
   */
  iterateMessagesDesc(roomId: string): IterableIterator<{ message_type: string; sender_kind: UserKind }> {
    return this.db
      .prepare(
        `SELECT m.message_type AS message_type, u.kind AS sender_kind
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.room_id = ?
         ORDER BY m.created_at DESC, m.id DESC`,
      )
      .iterate(roomId) as IterableIterator<{ message_type: string; sender_kind: UserKind }>;
  }

  // --- artifacts ---------------------------------------------------------------

  insertArtifact(row: ArtifactRow): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (id, room_id, uploaded_by, filename, mime_type, size_bytes, sha256,
                                storage_path, approval_id, created_at, expires_at)
         VALUES (@id, @room_id, @uploaded_by, @filename, @mime_type, @size_bytes, @sha256,
                 @storage_path, @approval_id, @created_at, @expires_at)`,
      )
      .run(row);
  }

  getArtifactInRoom(roomId: string, artifactId: string): ArtifactRow | undefined {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE room_id = ? AND id = ?')
      .get(roomId, artifactId) as ArtifactRow | undefined;
  }

  listArtifacts(roomId: string): ArtifactRow[] {
    return this.db
      .prepare('SELECT * FROM artifacts WHERE room_id = ? ORDER BY created_at ASC, id ASC')
      .all(roomId) as ArtifactRow[];
  }

  // --- approvals -----------------------------------------------------------------

  insertApproval(row: ApprovalRow): void {
    this.db
      .prepare(
        `INSERT INTO approvals (id, room_id, requested_by, reviewer_user_id, approval_type,
                                payload_json, status, created_at, resolved_at, expires_at, consumed_at)
         VALUES (@id, @room_id, @requested_by, @reviewer_user_id, @approval_type,
                 @payload_json, @status, @created_at, @resolved_at, @expires_at, @consumed_at)`,
      )
      .run(row);
  }

  getApprovalInRoom(roomId: string, approvalId: string): ApprovalRow | undefined {
    return this.db
      .prepare('SELECT * FROM approvals WHERE room_id = ? AND id = ?')
      .get(roomId, approvalId) as ApprovalRow | undefined;
  }

  listApprovals(roomId: string): ApprovalRow[] {
    return this.db
      .prepare('SELECT * FROM approvals WHERE room_id = ? ORDER BY created_at ASC, id ASC')
      .all(roomId) as ApprovalRow[];
  }

  /** Persist a lazy pending->expired flip (no-op if the status changed meanwhile). */
  expireApproval(approvalId: string): void {
    this.db
      .prepare("UPDATE approvals SET status = 'expired' WHERE id = ? AND status = 'pending'")
      .run(approvalId);
  }

  resolveApproval(approvalId: string, decision: 'approved' | 'denied', ts: string): void {
    this.db
      .prepare("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
      .run(decision, ts, approvalId);
  }

  /** Mark an approved approval as used by an upload (single-use gate). */
  consumeApproval(approvalId: string, ts: string): void {
    this.db
      .prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .run(ts, approvalId);
  }
}
