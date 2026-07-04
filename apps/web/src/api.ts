/**
 * Small typed REST client for the clausroom server (docs/API-CONTRACT.md).
 * Every response body is validated with the shared zod schemas from
 * @clausroom/protocol before it reaches app state.
 */
import {
  ApiErrorSchema,
  ApprovalSchema,
  ArtifactSchema,
  MessageSchema,
  MyAgentResponseSchema,
  ParticipantSchema,
  RoleSchema,
  RoomSchema,
  UserSchema,
  type AddParticipantRequest,
  type Approval,
  type ApprovalStatus,
  type Artifact,
  type Message,
  type MyAgentResponse,
  type Participant,
  type PostMessageRequest,
  type Role,
  type Room,
  type UpdateSummaryRequest,
  type User,
} from '@clausroom/protocol';
import { getServerBase } from './storage.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
  }
}

export function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiClientError && err.status === 401;
}

/**
 * True for a 401 whose message mentions expiry (the sliding session TTL,
 * docs/API-CONTRACT.md §1 rule 4) — the stored session is dead for good and
 * the user needs a fresh invite token.
 */
export function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiClientError && err.status === 401 && /expir/i.test(err.message);
}

export function errorText(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  if (err instanceof Error) {
    if (err.name === 'TypeError' || /fetch/i.test(err.message)) {
      return 'Could not reach the server. Check your connection (and the server URL).';
    }
    return err.message;
  }
  return 'Something went wrong.';
}

// ---------------------------------------------------------------------------
// Response parsing helpers (wrappers checked by hand, entities via zod)
// ---------------------------------------------------------------------------

const MessagesArraySchema = MessageSchema.array();
const ParticipantsArraySchema = ParticipantSchema.array();
const ApprovalsArraySchema = ApprovalSchema.array();
const ArtifactsArraySchema = ArtifactSchema.array();

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApiClientError('bad_response', `Malformed server response (${what}).`, 0);
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') {
    throw new ApiClientError('bad_response', `Malformed server response (${what}).`, 0);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Low-level fetch
// ---------------------------------------------------------------------------

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  token?: string | null;
  body?: unknown;
}

async function request(path: string, opts: RequestOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${getServerBase()}${path}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiClientError(
      'network',
      'Could not reach the server. Check your connection (and the server URL).',
      0,
    );
  }

  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // Non-JSON error body; fall through to the generic error below.
    }
    const parsed = ApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiClientError(parsed.data.error.code, parsed.data.error.message, res.status);
    }
    throw new ApiClientError('http_error', `Request failed (HTTP ${res.status}).`, res.status);
  }

  try {
    return await res.json();
  } catch {
    throw new ApiClientError('bad_response', 'Server returned invalid JSON.', res.status);
  }
}

// ---------------------------------------------------------------------------
// Typed endpoints
// ---------------------------------------------------------------------------

export interface LoginResponse {
  session_token: string;
  user: User;
}

export async function login(inviteToken: string): Promise<LoginResponse> {
  const data = asRecord(
    await request('/api/auth/login', { method: 'POST', body: { invite_token: inviteToken } }),
    'login',
  );
  return {
    session_token: asString(data.session_token, 'session_token'),
    user: UserSchema.parse(data.user),
  };
}

export interface RoomMembership {
  room: Room;
  my_role: Role;
}

export interface MeResponse {
  user: User;
  rooms: RoomMembership[];
}

export async function me(token: string): Promise<MeResponse> {
  const data = asRecord(await request('/api/me', { token }), 'me');
  const roomsRaw = Array.isArray(data.rooms) ? data.rooms : [];
  return {
    user: UserSchema.parse(data.user),
    rooms: roomsRaw.map((entry) => {
      const rec = asRecord(entry, 'rooms[]');
      return { room: RoomSchema.parse(rec.room), my_role: RoleSchema.parse(rec.my_role) };
    }),
  };
}

export async function createRoom(token: string, name: string): Promise<Room> {
  const data = asRecord(
    await request('/api/rooms', { method: 'POST', token, body: { name } }),
    'create room',
  );
  return RoomSchema.parse(data.room);
}

export interface RoomDetail {
  room: Room;
  participants: Participant[];
  my_role: Role;
  /** Optional: servers may expose AGENT_ROOM_PUBLIC_BASE_URL for UI snippets. */
  public_base_url?: string;
  /** Effective AGENT_ROOM_MAX_AUTO_TURNS (the turn-budget meter denominator). */
  max_auto_turns?: number;
}

export async function getRoom(token: string, roomId: string): Promise<RoomDetail> {
  const data = asRecord(await request(`/api/rooms/${roomId}`, { token }), 'room');
  return {
    room: RoomSchema.parse(data.room),
    participants: ParticipantsArraySchema.parse(data.participants),
    my_role: RoleSchema.parse(data.my_role),
    public_base_url: optionalString(data.public_base_url),
    max_auto_turns: optionalNumber(data.max_auto_turns),
  };
}

/**
 * PUT /api/rooms/:id/summary — set (or clear, with null) the pinned room
 * summary. Returns the updated Room (summary_* fields included).
 */
export async function updateSummary(
  token: string,
  roomId: string,
  summaryMarkdown: string | null,
): Promise<Room> {
  const body: UpdateSummaryRequest = { summary_markdown: summaryMarkdown };
  const data = asRecord(
    await request(`/api/rooms/${roomId}/summary`, { method: 'PUT', token, body }),
    'update summary',
  );
  return RoomSchema.parse(data.room);
}

export async function getMessages(
  token: string,
  roomId: string,
  after?: string,
  limit?: number,
): Promise<Message[]> {
  const params = new URLSearchParams();
  if (after) params.set('after', after);
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const data = asRecord(
    await request(`/api/rooms/${roomId}/messages${qs ? `?${qs}` : ''}`, { token }),
    'messages',
  );
  return MessagesArraySchema.parse(data.messages);
}

export async function postMessage(
  token: string,
  roomId: string,
  body: PostMessageRequest,
): Promise<Message> {
  const data = asRecord(
    await request(`/api/rooms/${roomId}/messages`, { method: 'POST', token, body }),
    'post message',
  );
  return MessageSchema.parse(data.message);
}

export async function getApprovals(
  token: string,
  roomId: string,
  status?: ApprovalStatus,
): Promise<Approval[]> {
  const qs = status ? `?status=${status}` : '';
  const data = asRecord(await request(`/api/rooms/${roomId}/approvals${qs}`, { token }), 'approvals');
  return ApprovalsArraySchema.parse(data.approvals);
}

export async function respondApproval(
  token: string,
  roomId: string,
  approvalId: string,
  decision: 'approved' | 'denied',
): Promise<Approval> {
  const data = asRecord(
    await request(`/api/rooms/${roomId}/approvals/${approvalId}/respond`, {
      method: 'POST',
      token,
      body: { decision },
    }),
    'respond approval',
  );
  return ApprovalSchema.parse(data.approval);
}

export async function getArtifacts(token: string, roomId: string): Promise<Artifact[]> {
  const data = asRecord(await request(`/api/rooms/${roomId}/artifacts`, { token }), 'artifacts');
  return ArtifactsArraySchema.parse(data.artifacts);
}

export async function getArtifact(
  token: string,
  roomId: string,
  artifactId: string,
): Promise<Artifact> {
  const data = asRecord(
    await request(`/api/rooms/${roomId}/artifacts/${artifactId}`, { token }),
    'artifact',
  );
  return ArtifactSchema.parse(data.artifact);
}

export interface PauseResult {
  room?: Room;
  participant?: Participant;
}

export async function pause(
  token: string,
  roomId: string,
  target: 'all_agents' | string,
  paused: boolean,
): Promise<PauseResult> {
  const data = asRecord(
    await request(`/api/rooms/${roomId}/pause`, { method: 'POST', token, body: { target, paused } }),
    'pause',
  );
  const result: PauseResult = {};
  if (data.room !== undefined && data.room !== null) result.room = RoomSchema.parse(data.room);
  if (data.participant !== undefined && data.participant !== null) {
    result.participant = ParticipantSchema.parse(data.participant);
  }
  return result;
}

export interface AddParticipantResult {
  participant: Participant;
  invite_token?: string;
  bridge_token?: string;
}

export async function addParticipant(
  token: string,
  roomId: string,
  body: AddParticipantRequest,
): Promise<AddParticipantResult> {
  const data = asRecord(
    await request(`/api/rooms/${roomId}/participants`, { method: 'POST', token, body }),
    'add participant',
  );
  return {
    participant: ParticipantSchema.parse(data.participant),
    invite_token: optionalString(data.invite_token),
    bridge_token: optionalString(data.bridge_token),
  };
}

/**
 * POST /api/rooms/:id/my-agent — self-service agent provisioning for a logged-in
 * human participant (docs/API-CONTRACT.md §3). Creates the caller's agent (or
 * rotates its bridge token if one already exists) and returns the raw bridge
 * token plus a ready-to-run `join_command` — both shown exactly once. The guest
 * runs the one command locally to attach their agent, so no token is relayed by
 * hand.
 */
export async function provisionMyAgent(
  token: string,
  roomId: string,
  agentName?: string,
): Promise<MyAgentResponse> {
  const body = agentName ? { agent_name: agentName, role: 'agent' } : { role: 'agent' };
  const data = await request(`/api/rooms/${roomId}/my-agent`, { method: 'POST', token, body });
  return MyAgentResponseSchema.parse(data);
}

export interface RotateTokenResult {
  invite_token?: string;
  bridge_token?: string;
}

export async function rotateParticipantToken(
  token: string,
  roomId: string,
  userId: string,
): Promise<RotateTokenResult> {
  const data = asRecord(
    await request(`/api/rooms/${roomId}/participants/${userId}/token`, { method: 'POST', token }),
    'rotate token',
  );
  return {
    invite_token: optionalString(data.invite_token),
    bridge_token: optionalString(data.bridge_token),
  };
}

// ---------------------------------------------------------------------------
// Authenticated file downloads (Authorization header, so no plain <a href>)
// ---------------------------------------------------------------------------

async function downloadBlob(token: string, path: string, filename: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${getServerBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new ApiClientError('network', 'Could not reach the server for the download.', 0);
  }
  if (!res.ok) {
    // Surface the server's exact error message (e.g. "Artifact expired or
    // deleted.") instead of a bare HTTP status.
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      // Non-JSON error body; fall through to the generic error below.
    }
    const parsed = ApiErrorSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiClientError(parsed.data.error.code, parsed.data.error.message, res.status);
    }
    throw new ApiClientError('http_error', `Download failed (HTTP ${res.status}).`, res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function downloadTranscript(token: string, roomId: string): Promise<void> {
  return downloadBlob(token, `/api/rooms/${roomId}/export.md`, `${roomId}-transcript.md`);
}

export function downloadArtifact(token: string, artifact: Artifact): Promise<void> {
  return downloadBlob(
    token,
    `/api/rooms/${artifact.room_id}/artifacts/${artifact.id}/download`,
    artifact.filename,
  );
}
