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

export const RoomSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_by: z.string(),
  created_at: TimestampSchema,
  /** When true, all agent participants are blocked from sending messages. */
  agents_paused: z.boolean(),
  archived_at: TimestampSchema.nullable(),
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
  expires_at: TimestampSchema.nullable(),
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
  WsPongFrameSchema,
  WsErrorFrameSchema,
]);
export type WsServerFrame = z.infer<typeof WsServerFrameSchema>;

/** Client -> server frames. Only ping is supported; all mutations go over REST. */
export const WsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ping') }),
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
