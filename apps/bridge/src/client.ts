/**
 * Typed clausroom server client used by the bridge:
 *
 *  - REST wrapper with bearer auth, zod-validated responses, and descriptive
 *    errors mapping the contract's error codes (docs/API-CONTRACT.md §7).
 *  - WebSocket connection to /ws with exponential-backoff reconnect and an
 *    async event bus for server push frames (message_created,
 *    approval_created, approval_resolved, ...).
 *
 * Everything the server returns is untrusted input and is validated with the
 * shared zod schemas from @clausroom/protocol before use.
 */

import { createHash } from 'node:crypto';
import { createWriteStream, openAsBlob } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import WebSocket from 'ws';
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
  WsServerFrameSchema,
  type Approval,
  type ApprovalStatus,
  type Artifact,
  type CreateApprovalRequest,
  type ErrorCode,
  type Message,
  type Room,
  type UpdateSummaryRequest,
  type WsClientFrame,
  type WsServerFrame,
} from '@clausroom/protocol';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Friendly, agent-readable hints per contract error code. */
const ERROR_HINTS: Partial<Record<ErrorCode, string>> = {
  unauthorized:
    'The bridge token was rejected (missing, revoked, or invalid). Ask the room owner to rotate/reissue your bridge token.',
  forbidden:
    'This action is not allowed for this token (bridge tokens are scoped to one room and cannot perform human-only actions).',
  agents_paused: 'All agents are paused in this room. Stop and wait for a human to resume agents.',
  participant_paused:
    'You are paused in this room. Stop and wait for your human to resume you.',
  approval_required:
    'The server requires an approved artifact_upload approval before this upload. Request one with room_request_human_approval.',
  not_found:
    'The referenced room/message/artifact/approval/participant was not found (or this token is not a participant of the room).',
  conflict: 'The action conflicts with current state (e.g. the approval was already resolved).',
  too_large: 'The payload exceeds the server size limit.',
  validation: 'The request failed server-side validation.',
  inline_blob:
    'The server rejected inline file content in the message body. Upload an artifact instead.',
  turn_limit:
    'Agent turn limit reached. Stop now and wait for a human to reply before sending more messages.',
  rate_limited: 'Message rate limit exceeded. Slow down and wait before sending more.',
};

/** An HTTP error from the clausroom server, mapped to the contract's ApiError. */
export class ApiRequestError extends Error {
  constructor(
    /** HTTP status (0 for network-level failures). */
    readonly status: number,
    /** Contract error code, or 'network' when the server was unreachable. */
    readonly code: ErrorCode | 'network' | 'unknown',
    /** Server-supplied (or synthesized) message. */
    readonly serverMessage: string,
  ) {
    const hint = code !== 'network' && code !== 'unknown' ? ERROR_HINTS[code] : undefined;
    super(
      `${code} (HTTP ${status}): ${serverMessage}${hint ? ` — ${hint}` : ''}`,
    );
    this.name = 'ApiRequestError';
  }
}

// ---------------------------------------------------------------------------
// Response schemas (zod-validated wrappers around protocol entities)
// ---------------------------------------------------------------------------

const HealthzResponseSchema = z.object({ ok: z.boolean() });
const MeResponseSchema = z.object({ user: UserSchema });
const RoomResponseSchema = z.object({
  room: RoomSchema,
  participants: z.array(ParticipantSchema),
  my_role: RoleSchema,
});
const MessagesResponseSchema = z.object({ messages: z.array(MessageSchema) });
const PostMessageResponseSchema = z.object({ message: MessageSchema });
const ArtifactResponseSchema = z.object({ artifact: ArtifactSchema });
const UploadResponseSchema = z.object({ artifact: ArtifactSchema, message: MessageSchema });
const ApprovalsResponseSchema = z.object({ approvals: z.array(ApprovalSchema) });
const ApprovalResponseSchema = z.object({ approval: ApprovalSchema });
const UpdateSummaryResponseSchema = z.object({ room: RoomSchema });

export type RoomInfo = z.infer<typeof RoomResponseSchema>;

export interface PostMessageBody {
  recipient_ids: string[];
  message_type: string;
  body_markdown: string;
  reply_to_message_id?: string;
  confidence?: string;
  artifact_ids?: string[];
  /** Decision-card options (contract §4 rule 9): 1..6 strings, ≤120 chars each. */
  choices?: string[];
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

export class RoomClient {
  constructor(
    readonly serverUrl: string,
    readonly roomId: string,
    private readonly token: string,
  ) {}

  private async request<T>(
    schema: z.ZodType<T>,
    method: string,
    apiPath: string,
    opts: { json?: unknown; form?: FormData; auth?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const { json, form, auth = true, timeoutMs = REQUEST_TIMEOUT_MS } = opts;
    const headers: Record<string, string> = {};
    if (auth) headers['authorization'] = `Bearer ${this.token}`;
    let body: string | FormData | undefined;
    if (json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      body = form; // fetch sets the multipart boundary itself
    }

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}${apiPath}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ApiRequestError(
        0,
        'network',
        `Cannot reach ${this.serverUrl}${apiPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      throw await this.toApiError(res);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ApiRequestError(res.status, 'unknown', 'Server returned a non-JSON 2xx response.');
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiRequestError(
        res.status,
        'unknown',
        `Server response did not match the API contract: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private async toApiError(res: Response): Promise<ApiRequestError> {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      /* ignore */
    }
    try {
      const parsed = ApiErrorSchema.safeParse(JSON.parse(bodyText));
      if (parsed.success) {
        return new ApiRequestError(res.status, parsed.data.error.code, parsed.data.error.message);
      }
    } catch {
      /* not JSON */
    }
    return new ApiRequestError(
      res.status,
      'unknown',
      bodyText.slice(0, 300) || `HTTP ${res.status} ${res.statusText}`,
    );
  }

  // -- Endpoints ------------------------------------------------------------

  async healthz(): Promise<boolean> {
    const out = await this.request(HealthzResponseSchema, 'GET', '/healthz', { auth: false });
    return out.ok;
  }

  async me(): Promise<z.infer<typeof UserSchema>> {
    const out = await this.request(MeResponseSchema, 'GET', '/api/me');
    return out.user;
  }

  async getRoom(): Promise<RoomInfo> {
    return this.request(RoomResponseSchema, 'GET', `/api/rooms/${this.roomId}`);
  }

  /** PUT /api/rooms/:id/summary — set (string) or clear (null) the pinned room summary. */
  async updateSummary(body: UpdateSummaryRequest): Promise<Room> {
    const out = await this.request(
      UpdateSummaryResponseSchema,
      'PUT',
      `/api/rooms/${this.roomId}/summary`,
      { json: body },
    );
    return out.room;
  }

  async listMessages(opts: { after?: string; limit?: number } = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (opts.after) params.set('after', opts.after);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    const out = await this.request(
      MessagesResponseSchema,
      'GET',
      `/api/rooms/${this.roomId}/messages${qs}`,
    );
    return out.messages;
  }

  async postMessage(body: PostMessageBody): Promise<Message> {
    const out = await this.request(
      PostMessageResponseSchema,
      'POST',
      `/api/rooms/${this.roomId}/messages`,
      { json: body },
    );
    return out.message;
  }

  async getArtifact(artifactId: string): Promise<Artifact> {
    const out = await this.request(
      ArtifactResponseSchema,
      'GET',
      `/api/rooms/${this.roomId}/artifacts/${artifactId}`,
    );
    return out.artifact;
  }

  async uploadArtifact(opts: {
    absPath: string;
    filename: string;
    mimeType: string;
    description?: string;
    approvalId?: string;
  }): Promise<{ artifact: Artifact; message: Message }> {
    const blob = await openAsBlob(opts.absPath, { type: opts.mimeType });
    const form = new FormData();
    form.append('file', blob, opts.filename);
    if (opts.description) form.append('description', opts.description);
    if (opts.approvalId) form.append('approval_id', opts.approvalId);
    return this.request(
      UploadResponseSchema,
      'POST',
      `/api/rooms/${this.roomId}/artifacts`,
      { form, timeoutMs: 10 * 60_000 },
    );
  }

  /**
   * Stream an artifact download to `destPath`, verifying its SHA-256 along the
   * way. Throws if the hash does not match `expectedSha256` (the partial file
   * is removed by the caller).
   */
  async downloadArtifactTo(
    artifactId: string,
    destPath: string,
    expectedSha256: string,
  ): Promise<void> {
    let res: Response;
    try {
      res = await fetch(
        `${this.serverUrl}/api/rooms/${this.roomId}/artifacts/${artifactId}/download`,
        {
          headers: { authorization: `Bearer ${this.token}` },
          signal: AbortSignal.timeout(10 * 60_000),
        },
      );
    } catch (err) {
      throw new ApiRequestError(
        0,
        'network',
        `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) throw await this.toApiError(res);
    if (!res.body) {
      throw new ApiRequestError(res.status, 'unknown', 'Download response had no body.');
    }
    const hash = createHash('sha256');
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(destPath),
    );
    const actual = hash.digest('hex');
    if (actual !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Downloaded content hash mismatch: expected sha256 ${expectedSha256}, got ${actual}. The file was discarded.`,
      );
    }
  }

  async listApprovals(status?: ApprovalStatus): Promise<Approval[]> {
    const qs = status ? `?status=${status}` : '';
    const out = await this.request(
      ApprovalsResponseSchema,
      'GET',
      `/api/rooms/${this.roomId}/approvals${qs}`,
    );
    return out.approvals;
  }

  async createApproval(body: CreateApprovalRequest): Promise<Approval> {
    const out = await this.request(
      ApprovalResponseSchema,
      'POST',
      `/api/rooms/${this.roomId}/approvals`,
      { json: body },
    );
    return out.approval;
  }
}

// ---------------------------------------------------------------------------
// WebSocket event bus
// ---------------------------------------------------------------------------

type FrameListener = (frame: WsServerFrame) => void;

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_INTERVAL_MS = 25_000;

/** Close codes the server uses for auth/participation failures (contract §8). */
const FATAL_CLOSE_CODES = new Set([4001, 4003, 4004]);

/**
 * Outbound-only WebSocket to GET /ws?room_id=…&token=… with exponential
 * backoff reconnect. Reconnecting re-issues the same query string, which IS
 * the room subscription, so every reconnect resubscribes automatically.
 * Valid server frames are fanned out to listeners; `waitFor` gives tools an
 * async long-poll primitive over the bus.
 */
export class RoomSocket {
  private ws: WebSocket | null = null;
  private stopped = false;
  private fatal: string | null = null;
  private backoffMs = BACKOFF_INITIAL_MS;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<FrameListener>();

  constructor(
    private readonly serverUrl: string,
    private readonly roomId: string,
    private readonly token: string,
    /** All diagnostics go to stderr — stdout belongs to the MCP transport. */
    private readonly log: (line: string) => void,
  ) {}

  /** Human-readable reason the socket gave up, or null while it keeps trying. */
  get fatalError(): string | null {
    return this.fatal;
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearPing();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /** Subscribe to validated server frames; returns an unsubscribe function. */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Best-effort send of a client frame (ping / activity status). Returns true
   * when the frame was handed to an OPEN socket, false otherwise. Callers must
   * treat failure as non-fatal — activity frames are best-effort by contract
   * (§12): if the WS is down, tool execution proceeds and no frame is sent.
   */
  send(frame: WsClientFrame): boolean {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Long-poll the event bus: resolve with the first non-null value produced by
   * `match`, or null after `timeoutMs`.
   */
  waitFor<T>(match: (frame: WsServerFrame) => T | null, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: T | null) => {
        if (done) return;
        done = true;
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = this.onFrame((frame) => {
        try {
          const value = match(frame);
          if (value !== null) finish(value);
        } catch {
          /* a bad matcher must not kill the bus */
        }
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  private wsUrl(): string {
    const u = new URL(this.serverUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = `${u.pathname.replace(/\/$/, '')}/ws`;
    u.search = new URLSearchParams({ room_id: this.roomId, token: this.token }).toString();
    return u.toString();
  }

  private connect(): void {
    if (this.stopped || this.fatal) return;
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = BACKOFF_INITIAL_MS;
      this.log(`ws: connected to ${this.serverUrl}/ws (room ${this.roomId})`);
      this.clearPing();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        this.log('ws: ignoring non-JSON frame from server');
        return;
      }
      const parsed = WsServerFrameSchema.safeParse(data);
      if (!parsed.success) {
        this.log('ws: ignoring frame that does not match WsServerFrameSchema');
        return;
      }
      for (const listener of this.listeners) {
        try {
          listener(parsed.data);
        } catch {
          /* a bad listener must not kill the socket */
        }
      }
    });

    ws.on('error', (err) => {
      this.log(`ws: error: ${err instanceof Error ? err.message : String(err)}`);
    });

    ws.on('close', (code, reasonBuf) => {
      this.clearPing();
      this.ws = null;
      if (this.stopped) return;
      const reason = reasonBuf.toString() || '(no reason)';
      if (FATAL_CLOSE_CODES.has(code)) {
        this.fatal =
          `WebSocket closed with code ${code} (${reason}). ` +
          (code === 4001
            ? 'The token was rejected — check the bridge token.'
            : code === 4003
              ? 'This token is not a participant of the room (or is scoped to a different room).'
              : 'Unknown room — check room.room_id in bridge.toml.');
        this.log(`ws: FATAL — ${this.fatal} Not reconnecting.`);
        return;
      }
      this.log(
        `ws: disconnected (code ${code}, ${reason}); reconnecting in ${Math.round(this.backoffMs / 1000)}s`,
      );
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    });
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }
}
