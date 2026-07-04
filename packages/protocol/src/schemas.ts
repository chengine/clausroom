import { z } from 'zod';
import {
  APPROVAL_TYPES,
  CONFIDENCE,
  DEFAULTS,
  ERROR_CODES,
  MESSAGE_TYPES,
} from './constants.js';

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const UserKindSchema = z.enum(['human', 'agent', 'bridge', 'system']);
export type UserKind = z.infer<typeof UserKindSchema>;

export const RoleSchema = z.enum(['owner', 'human', 'agent', 'observer']);
export type Role = z.infer<typeof RoleSchema>;

export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export const ConfidenceSchema = z.enum(CONFIDENCE);
export const ApprovalTypeSchema = z.enum(APPROVAL_TYPES);
export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApprovalStatusSchema = z.enum(['pending', 'approved', 'denied', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

/** Agent activity state, carried by WS 'status' (client) and 'activity' (server) frames. */
export const ActivityStateSchema = z.enum(['working', 'idle']);
export type ActivityState = z.infer<typeof ActivityStateSchema>;

/** ISO-8601 UTC timestamp string, e.g. "2026-07-02T19:04:05.123Z". */
export const TimestampSchema = z.string();

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  kind: UserKindSchema,
  is_admin: z.boolean(),
  /** For agent users: the human user who owns/reviews this agent. Null otherwise. */
  owner_user_id: z.string().nullable(),
  created_at: TimestampSchema,
});
export type User = z.infer<typeof UserSchema>;

/**
 * Resolved (effective) per-room numeric settings the UI needs. The server
 * computes each as `room override ?? server global env default` and reads the
 * resolved value PER-REQUEST — so the turn-limit check, the artifact retention
 * sweep, and the storage-quota check all honor a live override with NO restart.
 * These are Tier-1 host-owned settings (see docs/API-CONTRACT.md §3 and the
 * Tier-1/Tier-2 security split).
 */
export const RoomEffectiveSettingsSchema = z.object({
  /** Effective consecutive-agent turn limit (room override ?? AGENT_ROOM_MAX_AUTO_TURNS). */
  max_auto_turns: z.number().int().positive(),
  /**
   * Effective artifact retention in float days (room override ??
   * AGENT_ROOM_ARTIFACT_RETENTION_DAYS). `0` = immediate expiry; `null` =
   * retention disabled (the global default is `off`/negative and the room set no
   * override — matches the server's ServerConfig.artifactRetentionDays).
   */
  retention_days: z.number().nonnegative().nullable(),
  /** Effective per-room storage quota in bytes (room override ?? AGENT_ROOM_ROOM_STORAGE_BYTES). */
  storage_bytes: z.number().int().positive(),
});
export type RoomEffectiveSettings = z.infer<typeof RoomEffectiveSettingsSchema>;

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_by: z.string(),
  created_at: TimestampSchema,
  /** When true, all agent participants are blocked from sending messages. */
  agents_paused: z.boolean(),
  archived_at: TimestampSchema.nullable(),
  /**
   * Pinned room summary (markdown, max DEFAULTS.SUMMARY_MAX_CHARS). Null when unset.
   * The server always includes the three summary_* fields (optional here only so
   * clients tolerate pre-v0.1 servers during rolling upgrades).
   */
  summary_markdown: z.string().nullable().optional(),
  /** User id of whoever last updated the summary. Null when never updated. */
  summary_updated_by: z.string().nullable().optional(),
  summary_updated_at: TimestampSchema.nullable().optional(),
  /**
   * Per-room setting OVERRIDES (Tier 1: owner-owned and server-owned; changed
   * live via PATCH /api/rooms/:id/settings). `null` = fall back to the server
   * global env default for that setting; a number pins the override. The server
   * reads the resolved value (see `effective_settings`) PER-REQUEST, so changes
   * take effect with NO restart. These fields are always present from a v0.1
   * server (null when unset); optional here only so clients tolerate pre-v0.1
   * servers during rolling upgrades. See docs/API-CONTRACT.md §3.
   */
  /** Override for AGENT_ROOM_MAX_AUTO_TURNS (int 1..100). null = use global default. */
  max_auto_turns: z.number().int().min(1).max(100).nullable().optional(),
  /** Override for AGENT_ROOM_ARTIFACT_RETENTION_DAYS (float days >= 0; 0 = immediate expiry). null = use global default. */
  retention_days: z.number().nonnegative().nullable().optional(),
  /** Override for AGENT_ROOM_ROOM_STORAGE_BYTES (int > 0). null = use global default. */
  storage_bytes: z.number().int().positive().nullable().optional(),
  /**
   * Resolved effective settings (each = override ?? global default) the UI needs.
   * The server always includes this; optional here only for pre-v0.1 tolerance.
   */
  effective_settings: RoomEffectiveSettingsSchema.optional(),
});
export type Room = z.infer<typeof RoomSchema>;

export const ParticipantSchema = z.object({
  room_id: z.string(),
  user_id: z.string(),
  role: RoleSchema,
  can_send: z.boolean(),
  can_upload: z.boolean(),
  /** Per-participant pause flag (independent of room.agents_paused). */
  paused: z.boolean(),
  /** The participant's user record, embedded for convenience. */
  user: UserSchema,
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const MessageSenderSchema = z.object({
  id: z.string(),
  kind: UserKindSchema,
  display_name: z.string(),
});
export type MessageSender = z.infer<typeof MessageSenderSchema>;

/**
 * Inline decision-card choices: 1..DEFAULTS.CHOICES_MAX strings of
 * 1..DEFAULTS.CHOICE_MAX_CHARS chars each.
 */
export const MessageChoicesSchema = z
  .array(z.string().min(1).max(DEFAULTS.CHOICE_MAX_CHARS))
  .min(1)
  .max(DEFAULTS.CHOICES_MAX);
export type MessageChoices = z.infer<typeof MessageChoicesSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  /** Derived by the server from the auth token — never client-supplied. */
  sender: MessageSenderSchema,
  /** Empty array means "everyone in the room". */
  recipient_ids: z.array(z.string()),
  message_type: MessageTypeSchema,
  body_markdown: z.string(),
  artifact_ids: z.array(z.string()),
  reply_to_message_id: z.string().nullable(),
  confidence: ConfidenceSchema.nullable(),
  /**
   * Optional decision-card choices (see docs/API-CONTRACT.md §4). Null and
   * omitted are equivalent ("no choices"); the server returns null when unset.
   */
  choices: MessageChoicesSchema.nullable().optional(),
  created_at: TimestampSchema,
});
export type Message = z.infer<typeof MessageSchema>;

export const ArtifactSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  uploaded_by: z.string(),
  /** Server-sanitized filename (basename only, max 128 chars). */
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
  /** Lowercase hex SHA-256 of the file content. */
  sha256: z.string(),
  approval_id: z.string().nullable(),
  created_at: TimestampSchema,
  /** When retention is enabled: created_at + retention. Null when retention is disabled. */
  expires_at: TimestampSchema.nullable(),
  /**
   * Set by the retention sweep when the stored file is unlinked. Metadata routes
   * still return the row; downloads of a deleted/expired artifact return 404.
   * The server always includes this field (optional here only so clients
   * tolerate pre-v0.1 servers during rolling upgrades).
   */
  deleted_at: TimestampSchema.nullable().optional(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  room_id: z.string(),
  requested_by: z.string(),
  /** The human user who alone may respond (the requesting agent's owner). */
  reviewer_user_id: z.string(),
  approval_type: ApprovalTypeSchema,
  /** Free-form JSON object describing the requested action. */
  payload: z.record(z.unknown()),
  status: ApprovalStatusSchema,
  created_at: TimestampSchema,
  resolved_at: TimestampSchema.nullable(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ---------------------------------------------------------------------------
// REST request bodies
// ---------------------------------------------------------------------------

export const LoginRequestSchema = z.object({
  invite_token: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const CreateRoomRequestSchema = z.object({
  name: z.string().min(1).max(200),
});
export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;

export const AddParticipantRequestSchema = z.object({
  display_name: z.string().min(1).max(100),
  kind: z.enum(['human', 'agent']),
  role: RoleSchema,
  /**
   * For kind 'agent': the human participant who reviews this agent's approvals.
   * Defaults to the caller. Must be a human participant of the room.
   */
  owner_user_id: z.string().optional(),
});
export type AddParticipantRequest = z.infer<typeof AddParticipantRequestSchema>;

export const PostMessageRequestSchema = z.object({
  /** Empty (default) means "everyone in the room". */
  recipient_ids: z.array(z.string()).default([]),
  message_type: MessageTypeSchema,
  body_markdown: z.string().min(1).max(DEFAULTS.MAX_BODY_CHARS),
  reply_to_message_id: z.string().optional(),
  confidence: ConfidenceSchema.optional(),
  artifact_ids: z.array(z.string()).optional(),
  /** Optional decision-card choices (docs/API-CONTRACT.md §4). */
  choices: MessageChoicesSchema.optional(),
});
export type PostMessageRequest = z.infer<typeof PostMessageRequestSchema>;

export const PauseRequestSchema = z.object({
  /** 'all_agents' flips room.agents_paused; otherwise a user id flips that participant's paused flag. */
  target: z.union([z.literal('all_agents'), z.string().min(1)]),
  paused: z.boolean(),
});
export type PauseRequest = z.infer<typeof PauseRequestSchema>;

export const RespondApprovalRequestSchema = z.object({
  decision: z.enum(['approved', 'denied']),
});
export type RespondApprovalRequest = z.infer<typeof RespondApprovalRequestSchema>;

export const CreateApprovalRequestSchema = z.object({
  approval_type: ApprovalTypeSchema,
  payload: z.record(z.unknown()),
});
export type CreateApprovalRequest = z.infer<typeof CreateApprovalRequestSchema>;

/** PUT /api/rooms/:id/summary — null clears the summary back to unset. */
export const UpdateSummaryRequestSchema = z.object({
  summary_markdown: z.string().min(1).max(DEFAULTS.SUMMARY_MAX_CHARS).nullable(),
});
export type UpdateSummaryRequest = z.infer<typeof UpdateSummaryRequestSchema>;

/**
 * PATCH /api/rooms/:id/settings request body (OWNER only) — live Tier-1 per-room
 * setting overrides. Each field is OPTIONAL and three-valued:
 *   - omitted  → leave that override unchanged;
 *   - explicit `null` → clear the override back to the server global env default;
 *   - a number → set the override (validated against the ranges below).
 * Ranges mirror the RoomSchema override fields. The server validates ranges,
 * updates the room, broadcasts `room_updated` (including `effective_settings`),
 * and applies the change PER-REQUEST with NO restart. See docs/API-CONTRACT.md §3.
 */
export const RoomSettingsPatchRequestSchema = z.object({
  /** int 1..100; null clears back to AGENT_ROOM_MAX_AUTO_TURNS. */
  max_auto_turns: z.number().int().min(1).max(100).nullable().optional(),
  /** float days >= 0 (0 = immediate expiry); null clears back to AGENT_ROOM_ARTIFACT_RETENTION_DAYS. */
  retention_days: z.number().nonnegative().nullable().optional(),
  /** int > 0; null clears back to AGENT_ROOM_ROOM_STORAGE_BYTES. */
  storage_bytes: z.number().int().positive().nullable().optional(),
});
export type RoomSettingsPatchRequest = z.infer<typeof RoomSettingsPatchRequestSchema>;

// ---------------------------------------------------------------------------
// Self-service agent provisioning & bridge join blob (onboarding v2)
// See docs/API-CONTRACT.md §3 (POST /api/rooms/:id/my-agent) and §13
// (BridgeJoinBlob + `clausroom-bridge join`).
// ---------------------------------------------------------------------------

/**
 * POST /api/rooms/:id/my-agent request body. The caller — an authenticated HUMAN
 * participant (session token) — provisions THEIR OWN agent: if they already own an
 * agent participant in this room its bridge token is rotated; otherwise a new agent
 * participant is created with owner_user_id = the caller. This removes the
 * out-of-band bridge-token relay (a logged-in guest gets their own token in-app).
 */
export const MyAgentRequestSchema = z.object({
  /**
   * Display name for a newly created agent (defaults server-side, e.g.
   * "<human>'s Agent"). Ignored when rotating an existing agent's token.
   */
  agent_name: z.string().min(1).max(100).optional(),
  /** Only 'agent' is valid; present for forward-compat. Defaults to 'agent'. */
  role: z.literal('agent').default('agent'),
});
export type MyAgentRequest = z.infer<typeof MyAgentRequestSchema>;

/**
 * POST /api/rooms/:id/my-agent response. The raw `bridge_token` is shown exactly
 * ONCE here (on create OR rotate); `join_command` is the ready-to-run
 * `npx -y clausroom-bridge join <blob>` string embedding a BridgeJoinBlob for the
 * one-command bridge attach.
 */
export const MyAgentResponseSchema = z.object({
  participant: ParticipantSchema,
  /** Raw arbt_ bridge token — returned only in this response, never again. */
  bridge_token: z.string(),
  /** `npx -y clausroom-bridge join <base64url blob>` — one-command bridge attach. */
  join_command: z.string(),
});
export type MyAgentResponse = z.infer<typeof MyAgentResponseSchema>;

/**
 * Bridge join blob — base64url(JSON), no padding — carried by the
 * `clausroom-bridge join <blob>` command and embedded in
 * MyAgentResponse.join_command. Use encodeJoinBlob()/decodeJoinBlob() (join.ts).
 *
 * SECURITY INVARIANT: the blob encodes only CONNECTION info plus the recipient's
 * OWN bridge token. It NEVER carries local security config (filesystem roots, tool
 * scope, upload policy). `clausroom-bridge join` writes bridge.toml with SAFE LOCAL
 * DEFAULTS (read_only_default=true; roots chosen by the joining user, defaulting to
 * cwd — never server-provided). See docs/API-CONTRACT.md §13.
 */
export const BridgeJoinBlobSchema = z.object({
  /** Schema version; only 1 is defined. */
  v: z.literal(1),
  /** Room server base URL (http/https). Trailing slashes are stripped. */
  server_url: z
    .string()
    .min(1)
    .transform((s) => s.replace(/\/+$/, ''))
    .refine(
      (s) => {
        try {
          const u = new URL(s);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'server_url must be an http(s) URL' },
    ),
  /** Target room id (`room_` + 24 hex). */
  room_id: z.string().regex(/^room_[0-9a-f]{24}$/, 'room_id must be a room_ id'),
  /** The joining agent's OWN bridge token (`arbt_` + 32 hex). */
  token: z.string().regex(/^arbt_[0-9a-f]{32}$/, 'token must be an arbt_ bridge token'),
  /** Optional display name used to seed [identity].agent_name in bridge.toml. */
  agent_name: z.string().min(1).max(100).optional(),
});
export type BridgeJoinBlob = z.infer<typeof BridgeJoinBlobSchema>;

// ---------------------------------------------------------------------------
// WebSocket frames (server -> client), discriminated on "type"
// ---------------------------------------------------------------------------

export const WsHelloFrameSchema = z.object({
  type: z.literal('hello'),
  room: RoomSchema,
  participants: z.array(ParticipantSchema),
  /** User ids currently online (same payload as the 'presence' frame). */
  presence: z.array(z.string()),
  latest_message_id: z.string().nullable(),
});
export type WsHelloFrame = z.infer<typeof WsHelloFrameSchema>;

export const WsMessageCreatedFrameSchema = z.object({
  type: z.literal('message_created'),
  message: MessageSchema,
});
export type WsMessageCreatedFrame = z.infer<typeof WsMessageCreatedFrameSchema>;

export const WsApprovalCreatedFrameSchema = z.object({
  type: z.literal('approval_created'),
  approval: ApprovalSchema,
});
export type WsApprovalCreatedFrame = z.infer<typeof WsApprovalCreatedFrameSchema>;

export const WsApprovalResolvedFrameSchema = z.object({
  type: z.literal('approval_resolved'),
  approval: ApprovalSchema,
});
export type WsApprovalResolvedFrame = z.infer<typeof WsApprovalResolvedFrameSchema>;

export const WsParticipantUpdatedFrameSchema = z.object({
  type: z.literal('participant_updated'),
  participant: ParticipantSchema,
});
export type WsParticipantUpdatedFrame = z.infer<typeof WsParticipantUpdatedFrameSchema>;

export const WsRoomUpdatedFrameSchema = z.object({
  type: z.literal('room_updated'),
  room: RoomSchema,
});
export type WsRoomUpdatedFrame = z.infer<typeof WsRoomUpdatedFrameSchema>;

export const WsPresenceFrameSchema = z.object({
  type: z.literal('presence'),
  online_user_ids: z.array(z.string()),
});
export type WsPresenceFrame = z.infer<typeof WsPresenceFrameSchema>;

/**
 * Broadcast when an agent's activity state changes ('working' pill). Ephemeral:
 * never persisted; the server auto-reverts to idle after
 * DEFAULTS.ACTIVITY_IDLE_TIMEOUT_MS without a refreshing status frame, and on
 * disconnect of the agent's last socket.
 */
export const WsActivityFrameSchema = z.object({
  type: z.literal('activity'),
  payload: z.object({
    user_id: z.string(),
    state: ActivityStateSchema,
  }),
});
export type WsActivityFrame = z.infer<typeof WsActivityFrameSchema>;

export const WsPongFrameSchema = z.object({
  type: z.literal('pong'),
});
export type WsPongFrame = z.infer<typeof WsPongFrameSchema>;

export const WsErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: ErrorCodeSchema,
  message: z.string(),
});
export type WsErrorFrame = z.infer<typeof WsErrorFrameSchema>;

export const WsServerFrameSchema = z.discriminatedUnion('type', [
  WsHelloFrameSchema,
  WsMessageCreatedFrameSchema,
  WsApprovalCreatedFrameSchema,
  WsApprovalResolvedFrameSchema,
  WsParticipantUpdatedFrameSchema,
  WsRoomUpdatedFrameSchema,
  WsPresenceFrameSchema,
  WsActivityFrameSchema,
  WsPongFrameSchema,
  WsErrorFrameSchema,
]);
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>;

/**
 * Client -> server frames: ping (answered with pong) and agent activity status.
 * Status frames are honored only when the connection's user kind is 'agent'
 * (silently ignored otherwise). All mutations go over REST.
 */
export const WsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
  z.object({ type: z.literal('status'), state: ActivityStateSchema }),
]);
export type WsClientFrame = z.infer<typeof WsClientFrameSchema>;

// ---------------------------------------------------------------------------
// Error envelope (every non-2xx HTTP response body)
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    message: z.string(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
