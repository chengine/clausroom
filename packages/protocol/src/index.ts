/**
 * The wire contract: ids, limits, and zod schemas shared by the server, the web
 * UI, and the bridge. Everything either side sends the other is validated
 * against a schema in this file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Ids and tokens
// ---------------------------------------------------------------------------

/** Entity ids are `<prefix>_<24 hex>`, e.g. `room_9f8a...`. */
export type IdPrefix = 'user' | 'room' | 'msg' | 'art' | 'apr' | 'tok';

export function genId(prefix: IdPrefix): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * Bearer tokens are `<prefix>_<32 hex>`:
 *   invite  — single-use, exchanged for a session at POST /api/auth/login
 *   session — a human's browser credential
 *   bridge  — an agent's credential, scoped to one room
 */
export const TOKEN_PREFIX = { invite: 'arit_', session: 'arst_', bridge: 'arbt_' } as const;
export type TokenKind = keyof typeof TOKEN_PREFIX;

export function newToken(kind: TokenKind): string {
  return `${TOKEN_PREFIX[kind]}${randomBytes(16).toString('hex')}`;
}

/** The database stores only sha256Hex(token), so the file is not a credential store. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---------------------------------------------------------------------------
// Limits (fixed; there is nothing to tune for a two-person room)
// ---------------------------------------------------------------------------

export const LIMITS = {
  /** Characters in a message body. */
  BODY_CHARS: 32000,
  /** Characters in the pinned room summary. */
  SUMMARY_CHARS: 4000,
  /** Decision-card choices per message, and characters per choice. */
  CHOICES: 6,
  CHOICE_CHARS: 120,
  /** Messages returned by GET /messages without and with an explicit limit. */
  PAGE: 200,
  PAGE_MAX: 500,
  /** Consecutive agent messages allowed before a human must speak. */
  AGENT_TURNS: 3,
  /** Hard ceiling on one upload, whatever the local config allows. */
  UPLOAD_BYTES: 104857600,
  /** Aggregate artifact bytes retained by one room. */
  ROOM_ARTIFACT_BYTES: 1024 * 1024 * 1024,
  /** Simultaneous multipart bodies accepted by one host process. */
  UPLOAD_CONCURRENCY: 2,
  /** Serialized approval payload bytes, including field names. */
  APPROVAL_PAYLOAD_BYTES: 4096,
  /** One string/key and collection limits inside an approval payload. */
  APPROVAL_STRING_CHARS: 1024,
  APPROVAL_FIELDS: 32,
  APPROVAL_DEPTH: 4,
  /** A pending approval older than this reads as expired. */
  APPROVAL_TTL_MS: 3_600_000,
  /** An agent's "working" pill reverts to idle without a refreshing status frame. */
  ACTIVITY_IDLE_MS: 60_000,
  /** Tiny ping/status frames and a bounded number of live room sockets. */
  CLIENT_FRAME_BYTES: 4096,
  WS_CONNECTIONS: 128,
} as const;

// ---------------------------------------------------------------------------
// Browser peer transport
// ---------------------------------------------------------------------------

/**
 * The peer carries raw bytes between two browser-owned WebRTC data channels.
 * Neither the peer nor either browser can choose a target: the Node endpoints
 * on both sides are permanently wired to their own loopback Clausroom service.
 */
export const PEER = {
  VERSION: 2,
  CONTROL_CHANNEL: 'clausroom-control-v2',
  TUNNEL_CHANNEL_PREFIX: 'clausroom-tunnel-v2:',
  PATH: '/__clausroom_peer',
  CHUNK_BYTES: 16 * 1024,
  BUFFER_HIGH: 1024 * 1024,
  BUFFER_LOW: 256 * 1024,
  QUEUE_BYTES: 2 * 1024 * 1024,
  MAX_TUNNELS: 32,
  SIGNAL_BYTES: 256 * 1024,
} as const;

/** Shared policy for the same built UI served by host and guest loopback endpoints. */
export const WEB_CSP =
  "default-src 'self'; connect-src 'self' ws: wss: stun: stuns:; img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self'";

/** Credentials sent only after the manually authenticated DTLS link opens. */
export const PeerRoomInviteSchema = z.object({
  room: z.string().regex(/^room_[0-9a-f]{24}$/),
  human_id: z.string().regex(/^user_[0-9a-f]{24}$/),
  invite: z.string().regex(/^arit_[0-9a-f]{32}$/),
  token: z.string().regex(/^arbt_[0-9a-f]{32}$/),
  human: z.string().min(1).max(100),
  agent: z.string().min(1).max(100),
});
export type PeerRoomInvite = z.infer<typeof PeerRoomInviteSchema>;

const PeerCommonBootstrapSchema = z.object({
  v: z.literal(PEER.VERSION),
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  stun: z.array(z.string().regex(/^stuns?:/)).max(8),
});

/** Private, fragment-only handoff from a local CLI to its own browser. */
export const PeerBootstrapSchema = z.discriminatedUnion('role', [
  PeerCommonBootstrapSchema.extend({ role: z.literal('host'), room: PeerRoomInviteSchema }),
  PeerCommonBootstrapSchema.extend({ role: z.literal('guest') }),
]);
export type PeerBootstrap = z.infer<typeof PeerBootstrapSchema>;

/** The tiny structural surface shared by Node's net.Socket and ws.WebSocket. */
interface TunnelSocket {
  write(data: Uint8Array): boolean;
  pause(): this;
  resume(): this;
  end(): this;
  destroy(): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

interface TunnelWebSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array, options: { binary: true }, callback: (error?: Error) => void): void;
  pause(): void;
  resume(): void;
  close(): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): this;
}

function bytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (!Array.isArray(value) || value.some((part) => !(part instanceof Uint8Array))) return null;
  const parts = value as Uint8Array[];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Join one Node TCP socket to one binary WebSocket with bounded chunks and
 * backpressure. Closing either side closes only this tunnel.
 */
export function bindNodeTunnel(socket: TunnelSocket, ws: TunnelWebSocket): void {
  let aborted = false;
  const abort = (): void => {
    if (aborted) return;
    aborted = true;
    socket.destroy();
    if (ws.readyState === 1) ws.close();
    else ws.terminate();
  };
  const closeWebSocket = (): void => {
    if (ws.readyState === 1) ws.close();
    else if (ws.readyState === 0) ws.terminate();
  };

  socket.on('data', (raw: Uint8Array) => {
    if (aborted || ws.readyState !== 1) return abort();
    for (let offset = 0; offset < raw.byteLength; offset += PEER.CHUNK_BYTES) {
      const chunk = raw.subarray(offset, offset + PEER.CHUNK_BYTES);
      ws.send(chunk, { binary: true }, (error?: Error) => {
        if (error) return abort();
        if (!aborted && ws.bufferedAmount <= PEER.BUFFER_LOW) socket.resume();
      });
    }
    if (ws.bufferedAmount >= PEER.BUFFER_HIGH) socket.pause();
  });

  ws.on('message', (raw: unknown, binary: boolean) => {
    const chunk = binary ? bytes(raw) : null;
    if (!chunk || chunk.byteLength === 0 || chunk.byteLength > PEER.CHUNK_BYTES) return abort();
    if (!socket.write(chunk)) {
      ws.pause();
      socket.once('drain', () => {
        if (!aborted) ws.resume();
      });
    }
  });

  socket.on('end', closeWebSocket);
  socket.on('close', closeWebSocket);
  socket.on('error', abort);
  ws.on('close', () => {
    if (!aborted) socket.end();
  });
  ws.on('error', abort);
  socket.resume();
}

// ---------------------------------------------------------------------------
// Secret scanning
// ---------------------------------------------------------------------------

/** Credential shapes. A match blocks agent-sent text and agent uploads. */
export const SECRET_PATTERNS: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN OPENSSH PRIVATE KEY',
  'xoxb-',
  'ghp_',
  'github_pat_',
  'sk-[^\\s]{8,}',
];

/** Any raw clausroom bearer token. */
const TOKEN_PATTERN = 'ar(?:it|st|bt)_[0-9a-f]{32}';

/**
 * The server rewrites every match of these in a message body (from any sender)
 * to `[redacted-secret]` before storing or broadcasting it. A seatbelt for the
 * moment someone pastes a key into chat, not a guarantee.
 */
export const REDACTION_PATTERNS: readonly string[] = [...SECRET_PATTERNS, TOKEN_PATTERN];

const APPROVAL_SECRETS = REDACTION_PATTERNS.map((src) => new RegExp(src));
const INLINE_BLOB = /[A-Za-z0-9+/=]{2000,}/;

/** Every key and string value in a JSON-like payload, recursively. */
function payloadStrings(value: unknown): string[] {
  const found: string[] = [];
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const next = pending.pop();
    if (typeof next === 'string') found.push(next);
    else if (Array.isArray(next)) {
      if (seen.has(next)) continue;
      seen.add(next);
      pending.push(...next);
    }
    else if (next && typeof next === 'object') {
      if (seen.has(next)) continue;
      seen.add(next);
      for (const [key, child] of Object.entries(next)) {
        found.push(key);
        pending.push(child);
      }
    }
  }
  return found;
}

/** Why an approval payload could carry a secret/blob side channel, or null. */
export function approvalPayloadSafetyError(payload: Record<string, unknown>): string | null {
  for (const text of payloadStrings(payload)) {
    if (INLINE_BLOB.test(text)) return 'approval payloads cannot contain long base64 data';
    const secret = APPROVAL_SECRETS.find((pattern) => pattern.test(text));
    if (secret) return `approval payload matches the blocked secret pattern /${secret.source}/`;
  }
  return null;
}

/** One filesystem-independent filename normalizer, shared by bridge and server. */
export function safeFilename(original: string): string {
  const basename = original.split(/[\\/]/).at(-1) ?? '';
  const cleaned = basename.replace(/[^A-Za-z0-9._\- ()]/g, '_').slice(0, 128);
  return !cleaned || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

/**
 * Paths the bridge always refuses to read or upload (minimatch, dot: true).
 * Always on; there is no way to switch them off.
 */
export const DENY_GLOBS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/.ssh/**',
  '**/*.pem',
  '**/*.key',
  '**/*token*',
  '**/*credential*',
  '**/secrets/**',
  '**/node_modules/**',
  '**/.git/**',
];

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const MESSAGE_TYPES = [
  'human_message',
  'agent_question',
  'agent_answer',
  'evidence',
  'artifact_uploaded',
  'approval_request',
  'approval_response',
  'system_event',
  'resolution_summary',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export const APPROVAL_TYPES = ['artifact_upload', 'shell_command', 'code_edit', 'other'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

/** Every non-2xx response body is `{error: {code, message}}` with one of these. */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation',
  'turn_limit',
  'agents_paused',
  'participant_paused',
  'approval_required',
  'inline_blob',
  'too_large',
  'conflict',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const UserKindSchema = z.enum(['human', 'agent', 'system']);
export type UserKind = z.infer<typeof UserKindSchema>;

export const RoleSchema = z.enum(['owner', 'human', 'agent', 'observer']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export const ConfidenceSchema = z.enum(CONFIDENCE);
export const ApprovalTypeSchema = z.enum(APPROVAL_TYPES);
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export const ActivityStateSchema = z.enum(['working', 'idle']);
export type ActivityState = z.infer<typeof ActivityStateSchema>;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  kind: UserKindSchema,
  /** For an agent: the human who reviews its approvals. Null otherwise. */
  owner_user_id: z.string().nullable(),
  /** Insertion order; the UI sorts participants and picks their colors by it. */
  created_at: z.string(),
});
export type User = z.infer<typeof UserSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  /** True while every agent in the room is blocked from sending. */
  agents_paused: z.boolean(),
  /** Pinned shared whiteboard; null when unset. */
  summary_markdown: z.string().nullable(),
  summary_updated_by: z.string().nullable(),
  summary_updated_at: z.string().nullable(),
});
export type Room = z.infer<typeof RoomSchema>;

export const ParticipantSchema = z.object({
  user_id: z.string(),
  role: RoleSchema,
  can_send: z.boolean(),
  can_upload: z.boolean(),
  /** Paused on their own, independent of room.agents_paused. */
  paused: z.boolean(),
  user: UserSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

/** 1..LIMITS.CHOICES buttons rendering a message as a decision card. */
export const ChoicesSchema = z
  .array(z.string().min(1).max(LIMITS.CHOICE_CHARS))
  .min(1)
  .max(LIMITS.CHOICES);

export const MessageSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  /** Always derived from the caller's token, never from the request body. */
  sender: z.object({ id: z.string(), kind: UserKindSchema, display_name: z.string() }),
  /** Empty means everyone in the room. */
  recipient_ids: z.array(z.string()),
  message_type: MessageTypeSchema,
  body_markdown: z.string(),
  artifact_ids: z.array(z.string()),
  reply_to_message_id: z.string().nullable(),
  confidence: ConfidenceSchema.nullable(),
  choices: ChoicesSchema.nullable(),
  created_at: z.string(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  uploaded_by: z.string(),
  /** Sanitized basename. */
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  /** The approval that authorized this upload, for agent uploads. */
  approval_id: z.string().nullable(),
  created_at: z.string(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  requested_by: z.string(),
  /** The requesting agent's owner — the only person who may answer. */
  reviewer_user_id: z.string(),
  approval_type: ApprovalTypeSchema,
  payload: z.record(z.unknown()),
  status: ApprovalStatusSchema,
  created_at: z.string(),
  resolved_at: z.string().nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

export const LoginRequestSchema = z.object({ invite_token: z.string().min(1) });

export const CreateRoomRequestSchema = z.object({ name: z.string().min(1).max(200) });

export const AddParticipantRequestSchema = z.object({
  display_name: z.string().min(1).max(100),
  kind: z.enum(['human', 'agent']),
  role: RoleSchema,
  /** For an agent: who reviews its approvals. Defaults to the caller. */
  owner_user_id: z.string().optional(),
});
export type AddParticipantRequest = z.infer<typeof AddParticipantRequestSchema>;

export const PostMessageRequestSchema = z.object({
  recipient_ids: z.array(z.string()).default([]),
  message_type: MessageTypeSchema,
  body_markdown: z.string().min(1).max(LIMITS.BODY_CHARS),
  reply_to_message_id: z.string().optional(),
  confidence: ConfidenceSchema.optional(),
  artifact_ids: z.array(z.string()).optional(),
  choices: ChoicesSchema.optional(),
});

export const PauseRequestSchema = z.object({
  /** 'all_agents' or one participant's user id. */
  target: z.string().min(1),
  paused: z.boolean(),
});

export const RespondApprovalRequestSchema = z.object({
  decision: z.enum(['approved', 'denied']),
});

function approvalPayloadShapeError(value: unknown, depth = 0): string | null {
  if (depth > LIMITS.APPROVAL_DEPTH) {
    return `approval payloads may be at most ${LIMITS.APPROVAL_DEPTH} levels deep`;
  }
  if (value === null || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : 'numbers must be finite';
  if (typeof value === 'string') {
    return value.length <= LIMITS.APPROVAL_STRING_CHARS
      ? null
      : `approval strings may be at most ${LIMITS.APPROVAL_STRING_CHARS} characters`;
  }
  if (Array.isArray(value)) {
    if (value.length > LIMITS.APPROVAL_FIELDS) {
      return `approval arrays may contain at most ${LIMITS.APPROVAL_FIELDS} items`;
    }
    for (const child of value) {
      const error = approvalPayloadShapeError(child, depth + 1);
      if (error) return error;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return 'approval payloads must contain JSON values only';
  const entries = Object.entries(value);
  if (entries.length > LIMITS.APPROVAL_FIELDS) {
    return `approval objects may contain at most ${LIMITS.APPROVAL_FIELDS} fields`;
  }
  for (const [key, child] of entries) {
    if (key.length > LIMITS.APPROVAL_STRING_CHARS) {
      return `approval field names may be at most ${LIMITS.APPROVAL_STRING_CHARS} characters`;
    }
    const error = approvalPayloadShapeError(child, depth + 1);
    if (error) return error;
  }
  return null;
}

function checkApprovalPayload(payload: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const shape = approvalPayloadShapeError(payload);
  if (shape) ctx.addIssue({ code: z.ZodIssueCode.custom, message: shape });
  let serialized: string;
  try {
    serialized = JSON.stringify(payload);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'approval payload must be JSON' });
    return;
  }
  if (new TextEncoder().encode(serialized).byteLength > LIMITS.APPROVAL_PAYLOAD_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `approval payloads may be at most ${LIMITS.APPROVAL_PAYLOAD_BYTES} bytes`,
    });
  }
  const unsafe = approvalPayloadSafetyError(payload);
  if (unsafe) ctx.addIssue({ code: z.ZodIssueCode.custom, message: unsafe });
}

/** Small JSON metadata only; approval cards are not a second message/file channel. */
export const BoundedApprovalPayloadSchema = z
  .record(z.unknown())
  .superRefine(checkApprovalPayload);

/** The exact bytes a human approves before an agent may upload them. */
export const ArtifactUploadApprovalPayloadSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value === safeFilename(value), 'filename must be a sanitized basename'),
    size_bytes: z.number().int().nonnegative().max(LIMITS.UPLOAD_BYTES),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    description: z.string().min(1).max(LIMITS.APPROVAL_STRING_CHARS),
  })
  .strict()
  .superRefine(checkApprovalPayload);
export type ArtifactUploadApprovalPayload = z.infer<typeof ArtifactUploadApprovalPayloadSchema>;

export const CreateApprovalRequestSchema = z.discriminatedUnion('approval_type', [
  z.object({
    approval_type: z.literal('artifact_upload'),
    payload: ArtifactUploadApprovalPayloadSchema,
  }),
  z.object({
    approval_type: z.enum(['shell_command', 'code_edit', 'other']),
    payload: BoundedApprovalPayloadSchema,
  }),
]);
export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequestSchema>;

/** null clears the summary. */
export const UpdateSummaryRequestSchema = z.object({
  summary_markdown: z.string().min(1).max(LIMITS.SUMMARY_CHARS).nullable(),
});

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

export const ServerFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    room: RoomSchema,
    participants: z.array(ParticipantSchema),
    online_user_ids: z.array(z.string()),
  }),
  z.object({ type: z.literal('message_created'), message: MessageSchema }),
  z.object({ type: z.literal('approval_created'), approval: ApprovalSchema }),
  z.object({ type: z.literal('approval_resolved'), approval: ApprovalSchema }),
  z.object({ type: z.literal('participant_updated'), participant: ParticipantSchema }),
  z.object({ type: z.literal('room_updated'), room: RoomSchema }),
  z.object({ type: z.literal('presence'), online_user_ids: z.array(z.string()) }),
  z.object({
    type: z.literal('activity'),
    user_id: z.string(),
    state: ActivityStateSchema,
  }),
  z.object({ type: z.literal('pong') }),
  z.object({ type: z.literal('error'), code: ErrorCodeSchema, message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrameSchema>;

/** ping (answered with pong) and an agent's activity report. All writes go over REST. */
export const ClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('status'), state: ActivityStateSchema }),
]);
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

export const ApiErrorSchema = z.object({
  error: z.object({ code: ErrorCodeSchema, message: z.string() }),
});
