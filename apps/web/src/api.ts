/**
 * The room's REST API, typed. Every response is validated against the shared
 * schemas from @clausroom/protocol before it reaches app state.
 */
import { z } from 'zod';
import {
  ApiErrorSchema,
  ApprovalSchema,
  ArtifactSchema,
  MessageSchema,
  ParticipantSchema,
  RoleSchema,
  RoomSchema,
  UserSchema,
  type AddParticipantRequest,
  type Approval,
  type ApprovalStatus,
  type Artifact,
  type Message,
  type Participant,
  type Role,
  type Room,
  type User,
} from '@clausroom/protocol';

export class ApiClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiClientError && err.status === 401;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) {
    return err.name === 'TypeError' || /fetch/i.test(err.message)
      ? 'Could not reach the server. Check your connection.'
      : err.message;
  }
  return 'Something went wrong.';
}

const UNREACHABLE = 'Could not reach the server. Check your connection.';

/** Fetch, check the status, and validate the body — the only place that does. */
async function call<T>(
  schema: z.ZodType<T>,
  path: string,
  opts: { method?: 'GET' | 'POST' | 'PUT'; token?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch {
    throw new ApiClientError('network', UNREACHABLE, 0);
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) throw toError(payload, res.status);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiClientError('bad_response', `The server sent something unexpected (${path}).`, res.status);
  }
  return parsed.data;
}

function toError(payload: unknown, status: number): ApiClientError {
  const parsed = ApiErrorSchema.safeParse(payload);
  return parsed.success
    ? new ApiClientError(parsed.data.error.code, parsed.data.error.message, status)
    : new ApiClientError('http_error', `Request failed (HTTP ${status}).`, status);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const LoginReply = z.object({ session_token: z.string(), user: UserSchema });
const MeReply = z.object({
  user: UserSchema,
  rooms: z.array(z.object({ room: RoomSchema, my_role: RoleSchema })),
});
const RoomReply = z.object({ room: RoomSchema });
const RoomDetailReply = z.object({
  room: RoomSchema,
  participants: z.array(ParticipantSchema),
  my_role: RoleSchema,
  /** The room's turn limit — the denominator of the sidebar meter. */
  agent_turns: z.number().int(),
});
const MessagesReply = z.object({ messages: z.array(MessageSchema) });
const MessageReply = z.object({ message: MessageSchema });
const ApprovalsReply = z.object({ approvals: z.array(ApprovalSchema) });
const ApprovalReply = z.object({ approval: ApprovalSchema });
const ArtifactsReply = z.object({ artifacts: z.array(ArtifactSchema) });
const ArtifactReply = z.object({ artifact: ArtifactSchema });
const PauseReply = z.object({
  room: RoomSchema.optional(),
  participant: ParticipantSchema.optional(),
});
const TokenReply = z.object({
  participant: ParticipantSchema.optional(),
  invite_token: z.string().optional(),
  bridge_token: z.string().optional(),
});

export type MeResponse = z.infer<typeof MeReply>;
export type RoomDetail = z.infer<typeof RoomDetailReply>;
export type PauseResult = z.infer<typeof PauseReply>;
export type TokenResult = z.infer<typeof TokenReply>;

export function login(inviteToken: string): Promise<{ session_token: string; user: User }> {
  return call(LoginReply, '/api/auth/login', {
    method: 'POST',
    body: { invite_token: inviteToken },
  });
}

export function me(token: string): Promise<MeResponse> {
  return call(MeReply, '/api/me', { token });
}

export function createRoom(token: string, name: string): Promise<Room> {
  return call(RoomReply, '/api/rooms', { method: 'POST', token, body: { name } }).then((r) => r.room);
}

export function getRoom(token: string, roomId: string): Promise<RoomDetail> {
  return call(RoomDetailReply, `/api/rooms/${roomId}`, { token });
}

export function updateSummary(
  token: string,
  roomId: string,
  summaryMarkdown: string | null,
): Promise<Room> {
  return call(RoomReply, `/api/rooms/${roomId}/summary`, {
    method: 'PUT',
    token,
    body: { summary_markdown: summaryMarkdown },
  }).then((r) => r.room);
}

export function updateTurnLimit(token: string, roomId: string, agentTurnLimit: number): Promise<Room> {
  return call(RoomReply, `/api/rooms/${roomId}/turn-limit`, {
    method: 'PUT', token, body: { agent_turn_limit: agentTurnLimit },
  }).then((r) => r.room);
}

export function getMessages(
  token: string,
  roomId: string,
  after?: string,
  limit?: number,
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (after) params.set('after', after);
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.size > 0 ? `?${params}` : '';
  return call(MessagesReply, `/api/rooms/${roomId}/messages${query}`, { token }).then(
    (r) => r.messages,
  );
}

export function postMessage(
  token: string,
  roomId: string,
  body: {
    recipient_ids: string[];
    message_type: Message['message_type'];
    body_markdown: string;
    reply_to_message_id?: string;
  },
): Promise<Message> {
  return call(MessageReply, `/api/rooms/${roomId}/messages`, {
    method: 'POST',
    token,
    body,
  }).then((r) => r.message);
}

export function getApprovals(
  token: string,
  roomId: string,
  status?: ApprovalStatus,
): Promise<Approval[]> {
  return call(ApprovalsReply, `/api/rooms/${roomId}/approvals${status ? `?status=${status}` : ''}`, {
    token,
  }).then((r) => r.approvals);
}

export function respondApproval(
  token: string,
  roomId: string,
  approvalId: string,
  decision: 'approved' | 'denied',
): Promise<Approval> {
  return call(ApprovalReply, `/api/rooms/${roomId}/approvals/${approvalId}/respond`, {
    method: 'POST',
    token,
    body: { decision },
  }).then((r) => r.approval);
}

export function getArtifacts(token: string, roomId: string): Promise<Artifact[]> {
  return call(ArtifactsReply, `/api/rooms/${roomId}/artifacts`, { token }).then((r) => r.artifacts);
}

export function getArtifact(token: string, roomId: string, artifactId: string): Promise<Artifact> {
  return call(ArtifactReply, `/api/rooms/${roomId}/artifacts/${artifactId}`, { token }).then(
    (r) => r.artifact,
  );
}

export function pause(
  token: string,
  roomId: string,
  target: string,
  paused: boolean,
): Promise<PauseResult> {
  return call(PauseReply, `/api/rooms/${roomId}/pause`, {
    method: 'POST',
    token,
    body: { target, paused },
  });
}

export function addParticipant(
  token: string,
  roomId: string,
  body: AddParticipantRequest,
): Promise<TokenResult & { participant: Participant }> {
  return call(TokenReply, `/api/rooms/${roomId}/participants`, {
    method: 'POST',
    token,
    body,
  }) as Promise<TokenResult & { participant: Participant }>;
}

export function rotateToken(token: string, roomId: string, userId: string): Promise<TokenResult> {
  return call(TokenReply, `/api/rooms/${roomId}/participants/${userId}/token`, {
    method: 'POST',
    token,
  });
}

// ---------------------------------------------------------------------------
// Downloads (an Authorization header, so not a plain <a href>)
// ---------------------------------------------------------------------------

async function saveAs(token: string, path: string, filename: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiClientError('network', UNREACHABLE, 0);
  }
  if (!res.ok) throw toError(await res.json().catch(() => null), res.status);

  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadTranscript(token: string, roomId: string): Promise<void> {
  return saveAs(token, `/api/rooms/${roomId}/export.md`, `${roomId}-transcript.md`);
}

export function downloadArtifact(token: string, artifact: Artifact): Promise<void> {
  return saveAs(
    token,
    `/api/rooms/${artifact.room_id}/artifacts/${artifact.id}/download`,
    artifact.filename,
  );
}
