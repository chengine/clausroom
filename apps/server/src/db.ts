/**
 * SQLite storage. Every statement is prepared once and cached; every method
 * returns either a wire type from @clausroom/protocol or a row type declared
 * here for the few columns that never leave the server (storage_path,
 * token_hash, consumed_at).
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { genId } from '@clausroom/protocol';
import type {
  Approval,
  ApprovalStatus,
  Artifact,
  Message,
  Participant,
  Role,
  Room,
  TokenKind,
  User,
  UserKind,
} from '@clausroom/protocol';

export function nowIso(): string {
  return new Date().toISOString();
}

let lastStamp = 0;

/**
 * Strictly increasing timestamp for message created_at. Two inserts in the same
 * millisecond would otherwise order by random id, and an `after` cursor would
 * permanently skip whichever landed second.
 */
export function nextStamp(): string {
  const now = Date.now();
  lastStamp = now > lastStamp ? now : lastStamp + 1;
  return new Date(lastStamp).toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('human','agent','system')),
  owner_user_id TEXT REFERENCES users(id),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  created_at         TEXT NOT NULL,
  agents_paused      INTEGER NOT NULL DEFAULT 0,
  summary_markdown   TEXT,
  summary_updated_by TEXT REFERENCES users(id),
  summary_updated_at TEXT
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
  choices_json        TEXT,
  created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  room_id      TEXT NOT NULL REFERENCES rooms(id),
  uploaded_by  TEXT NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  approval_id  TEXT REFERENCES approvals(id),
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  room_id          TEXT NOT NULL REFERENCES rooms(id),
  requested_by     TEXT NOT NULL REFERENCES users(id),
  reviewer_user_id TEXT NOT NULL REFERENCES users(id),
  approval_type    TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')),
  created_at       TEXT NOT NULL,
  resolved_at      TEXT,
  consumed_at      TEXT
);

CREATE TABLE IF NOT EXISTS tokens (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('invite','session','bridge')),
  token_hash TEXT NOT NULL UNIQUE,
  user_id    TEXT NOT NULL REFERENCES users(id),
  room_id    TEXT REFERENCES rooms(id),
  used_at    TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_artifacts_room ON artifacts(room_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_approvals_room ON approvals(room_id, created_at, id);
`;

/** Columns of a message joined with its sender, in wire order. */
const MESSAGE_SELECT = `
  SELECT m.id, m.room_id, m.sender_id, u.kind AS sender_kind,
         u.display_name AS sender_name, m.recipient_ids_json, m.message_type,
         m.body_markdown, m.artifact_ids_json, m.reply_to_message_id,
         m.confidence, m.choices_json, m.created_at
  FROM messages m JOIN users u ON u.id = m.sender_id
`;

interface MessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  sender_kind: UserKind;
  sender_name: string;
  recipient_ids_json: string;
  message_type: string;
  body_markdown: string;
  artifact_ids_json: string;
  reply_to_message_id: string | null;
  confidence: string | null;
  choices_json: string | null;
  created_at: string;
}

/** A token as stored: the hash, never the token. */
export interface TokenRow {
  id: string;
  kind: TokenKind;
  token_hash: string;
  user_id: string;
  room_id: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

/** An approval plus the two columns the wire type omits. */
export interface ApprovalRow extends Approval {
  consumed_at: string | null;
}

/** Where an artifact's bytes live on disk. */
export interface ArtifactFile extends Artifact {
  storage_path: string;
}

/** New-message input; created_at and id are assigned here. */
export interface NewMessage {
  room_id: string;
  sender: User;
  message_type: Message['message_type'];
  body_markdown: string;
  recipient_ids?: string[];
  artifact_ids?: string[];
  reply_to_message_id?: string | null;
  confidence?: Message['confidence'];
  choices?: string[] | null;
}

function strings(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    /* corrupt json reads as empty */
  }
  return [];
}

function toMessage(row: MessageRow): Message {
  const choices = row.choices_json === null ? [] : strings(row.choices_json);
  return {
    id: row.id,
    room_id: row.room_id,
    sender: { id: row.sender_id, kind: row.sender_kind, display_name: row.sender_name },
    recipient_ids: strings(row.recipient_ids_json),
    message_type: row.message_type as Message['message_type'],
    body_markdown: row.body_markdown,
    artifact_ids: strings(row.artifact_ids_json),
    reply_to_message_id: row.reply_to_message_id,
    confidence: row.confidence as Message['confidence'],
    choices: choices.length > 0 ? choices : null,
    created_at: row.created_at,
  };
}

function toApproval(row: Omit<ApprovalRow, 'payload'> & { payload_json: string }): ApprovalRow {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload_json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      payload = parsed as Record<string, unknown>;
    }
  } catch {
    /* corrupt json reads as empty */
  }
  const { payload_json: _drop, ...rest } = row;
  return { ...rest, payload };
}

export class Store {
  private readonly db: Database.Database;
  private readonly cache = new Map<string, Database.Statement>();

  constructor(dbPath: string) {
    const file = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  /** Prepare once, reuse forever. */
  private q(sql: string): Database.Statement {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  // --- users ---------------------------------------------------------------

  addUser(user: Omit<User, 'created_at'>): User {
    const row = { ...user, created_at: nowIso() };
    this.q(
      `INSERT INTO users (id, display_name, kind, owner_user_id, created_at)
       VALUES (@id, @display_name, @kind, @owner_user_id, @created_at)`,
    ).run(row);
    return row;
  }

  user(id: string): User | undefined {
    return this.q('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  /** The singleton author of system_event messages. */
  systemUser(): User | undefined {
    return this.q("SELECT * FROM users WHERE kind = 'system' LIMIT 1").get() as User | undefined;
  }

  rename(userId: string, displayName: string): void {
    this.q('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
  }

  /** The room owner, created on first boot. */
  ownerUser(): User | undefined {
    return this.q(
      "SELECT * FROM users WHERE kind = 'human' ORDER BY created_at, id LIMIT 1",
    ).get() as User | undefined;
  }

  // --- tokens --------------------------------------------------------------

  addToken(kind: TokenKind, tokenHash: string, userId: string, roomId: string | null): void {
    this.q(
      `INSERT INTO tokens (id, kind, token_hash, user_id, room_id, used_at, revoked_at)
       VALUES (@id, @kind, @token_hash, @user_id, @room_id, NULL, NULL)`,
    ).run({
      id: genId('tok'),
      kind,
      token_hash: tokenHash,
      user_id: userId,
      room_id: roomId,
    });
  }

  token(tokenHash: string): TokenRow | undefined {
    return this.q('SELECT * FROM tokens WHERE token_hash = ?').get(tokenHash) as
      | TokenRow
      | undefined;
  }

  useInvite(id: string): void {
    this.q('UPDATE tokens SET used_at = ? WHERE id = ?').run(nowIso(), id);
  }

  /** Revoke every live token of a user, so a rotation invalidates the old one. */
  revokeTokens(userId: string): void {
    this.q('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
      nowIso(),
      userId,
    );
  }

  // --- rooms ---------------------------------------------------------------

  addRoom(name: string): Room {
    const room: Room = {
      id: genId('room'),
      name,
      created_at: nowIso(),
      agents_paused: false,
      summary_markdown: null,
      summary_updated_by: null,
      summary_updated_at: null,
    };
    this.q(
      `INSERT INTO rooms (id, name, created_at, agents_paused)
       VALUES (@id, @name, @created_at, 0)`,
    ).run({ id: room.id, name: room.name, created_at: room.created_at });
    return room;
  }

  room(id: string): Room | undefined {
    const row = this.q('SELECT * FROM rooms WHERE id = ?').get(id) as
      | (Omit<Room, 'agents_paused'> & { agents_paused: number })
      | undefined;
    return row ? { ...row, agents_paused: row.agents_paused === 1 } : undefined;
  }

  /** Rooms the user participates in, oldest first. */
  roomsOf(userId: string): Array<{ room: Room; my_role: Role }> {
    const rows = this.q(
      `SELECT r.*, p.role AS my_role
       FROM rooms r JOIN room_participants p ON p.room_id = r.id
       WHERE p.user_id = ? ORDER BY r.created_at, r.id`,
    ).all(userId) as Array<Omit<Room, 'agents_paused'> & { agents_paused: number; my_role: Role }>;
    return rows.map(({ my_role, agents_paused, ...room }) => ({
      room: { ...room, agents_paused: agents_paused === 1 },
      my_role,
    }));
  }

  pauseAgents(roomId: string, paused: boolean): void {
    this.q('UPDATE rooms SET agents_paused = ? WHERE id = ?').run(paused ? 1 : 0, roomId);
  }

  setSummary(roomId: string, summary: string | null, byUserId: string): void {
    this.q(
      `UPDATE rooms SET summary_markdown = ?, summary_updated_by = ?, summary_updated_at = ?
       WHERE id = ?`,
    ).run(summary, byUserId, nowIso(), roomId);
  }

  // --- participants --------------------------------------------------------

  addParticipant(roomId: string, user: User, role: Role): Participant {
    const canSend = role !== 'observer';
    this.q(
      `INSERT INTO room_participants (room_id, user_id, role, can_send, can_upload, paused)
       VALUES (?, ?, ?, ?, 1, 0)`,
    ).run(roomId, user.id, role, canSend ? 1 : 0);
    return { user_id: user.id, role, can_send: canSend, can_upload: true, paused: false, user };
  }

  participant(roomId: string, userId: string): Participant | undefined {
    return this.participants(roomId).find((p) => p.user_id === userId);
  }

  participants(roomId: string): Participant[] {
    const rows = this.q(
      `SELECT p.user_id, p.role, p.can_send, p.can_upload, p.paused,
              u.display_name, u.kind, u.owner_user_id, u.created_at
       FROM room_participants p JOIN users u ON u.id = p.user_id
       WHERE p.room_id = ? ORDER BY u.created_at, u.id`,
    ).all(roomId) as Array<{
      user_id: string;
      role: Role;
      can_send: number;
      can_upload: number;
      paused: number;
      display_name: string;
      kind: UserKind;
      owner_user_id: string | null;
      created_at: string;
    }>;
    return rows.map((r) => ({
      user_id: r.user_id,
      role: r.role,
      can_send: r.can_send === 1,
      can_upload: r.can_upload === 1,
      paused: r.paused === 1,
      user: {
        id: r.user_id,
        display_name: r.display_name,
        kind: r.kind,
        owner_user_id: r.owner_user_id,
        created_at: r.created_at,
      },
    }));
  }

  pauseParticipant(roomId: string, userId: string, paused: boolean): void {
    this.q('UPDATE room_participants SET paused = ? WHERE room_id = ? AND user_id = ?').run(
      paused ? 1 : 0,
      roomId,
      userId,
    );
  }

  // --- messages ------------------------------------------------------------

  addMessage(input: NewMessage): Message {
    const message: Message = {
      id: genId('msg'),
      room_id: input.room_id,
      sender: {
        id: input.sender.id,
        kind: input.sender.kind,
        display_name: input.sender.display_name,
      },
      recipient_ids: input.recipient_ids ?? [],
      message_type: input.message_type,
      body_markdown: input.body_markdown,
      artifact_ids: input.artifact_ids ?? [],
      reply_to_message_id: input.reply_to_message_id ?? null,
      confidence: input.confidence ?? null,
      choices: input.choices && input.choices.length > 0 ? input.choices : null,
      created_at: nextStamp(),
    };
    this.q(
      `INSERT INTO messages (id, room_id, sender_id, recipient_ids_json, message_type,
                             body_markdown, artifact_ids_json, reply_to_message_id,
                             confidence, choices_json, created_at)
       VALUES (@id, @room_id, @sender_id, @recipient_ids_json, @message_type,
               @body_markdown, @artifact_ids_json, @reply_to_message_id,
               @confidence, @choices_json, @created_at)`,
    ).run({
      id: message.id,
      room_id: message.room_id,
      sender_id: message.sender.id,
      recipient_ids_json: JSON.stringify(message.recipient_ids),
      message_type: message.message_type,
      body_markdown: message.body_markdown,
      artifact_ids_json: JSON.stringify(message.artifact_ids),
      reply_to_message_id: message.reply_to_message_id,
      confidence: message.confidence,
      choices_json: message.choices ? JSON.stringify(message.choices) : null,
      created_at: message.created_at,
    });
    return message;
  }

  message(roomId: string, messageId: string): Message | undefined {
    const row = this.q(`${MESSAGE_SELECT} WHERE m.room_id = ? AND m.id = ?`).get(
      roomId,
      messageId,
    ) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  /** One ascending page, optionally strictly after a cursor message. */
  messages(
    roomId: string,
    after: { created_at: string; id: string } | null,
    limit: number,
  ): Message[] {
    const rows = after
      ? this.q(
          `${MESSAGE_SELECT}
           WHERE m.room_id = ? AND (m.created_at > ? OR (m.created_at = ? AND m.id > ?))
           ORDER BY m.created_at, m.id LIMIT ?`,
        ).all(roomId, after.created_at, after.created_at, after.id, limit)
      : this.q(`${MESSAGE_SELECT} WHERE m.room_id = ? ORDER BY m.created_at, m.id LIMIT ?`).all(
          roomId,
          limit,
        );
    return (rows as MessageRow[]).map(toMessage);
  }

  /**
   * Length of the trailing run of agent messages, newest first. system_event
   * messages neither extend nor break it; any other human message ends it.
   */
  agentRun(roomId: string): number {
    const rows = this.q(
      `SELECT m.message_type, u.kind FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.room_id = ? ORDER BY m.created_at DESC, m.id DESC`,
    ).iterate(roomId) as IterableIterator<{ message_type: string; kind: UserKind }>;
    let run = 0;
    for (const row of rows) {
      if (row.message_type === 'system_event') continue;
      if (row.kind !== 'agent') break;
      run += 1;
    }
    return run;
  }

  // --- artifacts -----------------------------------------------------------

  addArtifact(row: ArtifactFile): void {
    this.q(
      `INSERT INTO artifacts (id, room_id, uploaded_by, filename, mime_type, size_bytes,
                              storage_path, approval_id, created_at)
       VALUES (@id, @room_id, @uploaded_by, @filename, @mime_type, @size_bytes,
               @storage_path, @approval_id, @created_at)`,
    ).run(row);
  }

  artifact(roomId: string, artifactId: string): ArtifactFile | undefined {
    return this.q('SELECT * FROM artifacts WHERE room_id = ? AND id = ?').get(
      roomId,
      artifactId,
    ) as ArtifactFile | undefined;
  }

  artifacts(roomId: string): ArtifactFile[] {
    return this.q(
      'SELECT * FROM artifacts WHERE room_id = ? ORDER BY created_at, id',
    ).all(roomId) as ArtifactFile[];
  }

  // --- approvals -----------------------------------------------------------

  addApproval(row: Omit<ApprovalRow, 'payload'> & { payload: Record<string, unknown> }): void {
    const { payload, ...rest } = row;
    this.q(
      `INSERT INTO approvals (id, room_id, requested_by, reviewer_user_id, approval_type,
                              payload_json, status, created_at, resolved_at, consumed_at)
       VALUES (@id, @room_id, @requested_by, @reviewer_user_id, @approval_type,
               @payload_json, @status, @created_at, @resolved_at, @consumed_at)`,
    ).run({ ...rest, payload_json: JSON.stringify(payload) });
  }

  approval(roomId: string, approvalId: string): ApprovalRow | undefined {
    const row = this.q('SELECT * FROM approvals WHERE room_id = ? AND id = ?').get(
      roomId,
      approvalId,
    ) as (Omit<ApprovalRow, 'payload'> & { payload_json: string }) | undefined;
    return row ? toApproval(row) : undefined;
  }

  approvals(roomId: string): ApprovalRow[] {
    const rows = this.q(
      'SELECT * FROM approvals WHERE room_id = ? ORDER BY created_at, id',
    ).all(roomId) as Array<Omit<ApprovalRow, 'payload'> & { payload_json: string }>;
    return rows.map(toApproval);
  }

  setApprovalStatus(approvalId: string, status: ApprovalStatus): void {
    this.q("UPDATE approvals SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(
      status,
      status === 'expired' ? null : nowIso(),
      approvalId,
    );
  }

  /** Mark an approval used, so one human "yes" authorizes exactly one upload. */
  consumeApproval(approvalId: string): void {
    this.q('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL').run(
      nowIso(),
      approvalId,
    );
  }
}
