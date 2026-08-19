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
  /** A pending approval older than this reads as expired. */
  APPROVAL_TTL_MS: 3_600_000,
  /** An agent's "working" pill reverts to idle without a refreshing status frame. */
  ACTIVITY_IDLE_MS: 60_000,
} as const;

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

export const CreateApprovalRequestSchema = z.object({
  approval_type: ApprovalTypeSchema,
  payload: z.record(z.unknown()),
});
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
