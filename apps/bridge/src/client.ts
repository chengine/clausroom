/**
 * Talking to the room: a REST wrapper and a reconnecting WebSocket.
 *
 * Everything the server returns is validated against the shared schemas before
 * it is used — from this side the server is just another untrusted input.
 */
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
  ServerFrameSchema,
  UserSchema,
  type Approval,
  type ApprovalStatus,
  type Artifact,
  type ClientFrame,
  type Confidence,
  type CreateApprovalRequest,
  type ErrorCode,
  type Message,
  type MessageType,
  type Room,
  type ServerFrame,
  type User,
} from '@clausroom/protocol';
import { message as errorText } from './util.js';

/** What the agent should do about each refusal, in words it can act on. */
const ADVICE: Partial<Record<ErrorCode, string>> = {
  unauthorized: 'The room rejected this token. Ask for a fresh one.',
  forbidden: 'This token is not allowed to do that.',
  agents_paused: 'Every agent is paused. Stop and wait for a human to resume.',
  participant_paused: 'You are paused. Stop and wait for your human to resume you.',
  approval_required: 'Request approval with room_request_human_approval first.',
  not_found: 'That room, message, artifact, approval, or participant does not exist.',
  conflict: 'The state changed underneath you — re-read before retrying.',
  too_large: 'That is over the size limit.',
  inline_blob: 'Do not paste file content into a message; upload an artifact.',
  turn_limit: 'You have had too many turns in a row. Stop and wait for a human reply.',
};

export class ApiError extends Error {
  constructor(
    /** 0 when the server could not be reached at all. */
    readonly status: number,
    readonly code: ErrorCode | 'network' | 'unknown',
    readonly detail: string,
  ) {
    const advice = ADVICE[code as ErrorCode];
    super(`${code} (HTTP ${status}): ${detail}${advice ? ` — ${advice}` : ''}`);
    this.name = 'ApiError';
  }
}

const RoomReply = z.object({
  room: RoomSchema,
  participants: z.array(ParticipantSchema),
  my_role: RoleSchema,
  agent_turns: z.number().int(),
});
export type RoomInfo = z.infer<typeof RoomReply>;

export interface Outgoing {
  message_type: MessageType;
  body_markdown: string;
  recipient_ids?: string[];
  reply_to_message_id?: string;
  confidence?: Confidence;
  choices?: string[];
}

const REQUEST_MS = 30_000;
const TRANSFER_MS = 10 * 60_000;

export class RoomClient {
  constructor(
    readonly serverUrl: string,
    readonly roomId: string,
    private readonly token: string,
  ) {}

  private async call<T>(
    schema: z.ZodType<T>,
    method: string,
    apiPath: string,
    opts: { json?: unknown; form?: FormData; anon?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (!opts.anon) headers.authorization = `Bearer ${this.token}`;
    let body: string | FormData | undefined;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.form !== undefined) {
      body = opts.form; // fetch picks the multipart boundary itself
    }

    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}${apiPath}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_MS),
      });
    } catch (err) {
      throw new ApiError(0, 'network', `cannot reach ${this.serverUrl}${apiPath}: ${errorText(err)}`);
    }
    if (!res.ok) throw await this.toError(res);

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new ApiError(res.status, 'unknown', 'the server sent a non-JSON success response');
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new ApiError(
        res.status,
        'unknown',
        `the server sent something unexpected: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      );
    }
    return parsed.data;
  }

  private async toError(res: Response): Promise<ApiError> {
    const text = await res.text().catch(() => '');
    try {
      const parsed = ApiErrorSchema.safeParse(JSON.parse(text));
      if (parsed.success) {
        return new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
      }
    } catch {
      /* not the error envelope */
    }
    return new ApiError(res.status, 'unknown', text.slice(0, 300) || `HTTP ${res.status}`);
  }

  async healthy(): Promise<boolean> {
    const out = await this.call(z.object({ ok: z.boolean() }), 'GET', '/healthz', { anon: true });
    return out.ok;
  }

  async me(): Promise<User> {
    const out = await this.call(z.object({ user: UserSchema }), 'GET', '/api/me');
    return out.user;
  }

  info(): Promise<RoomInfo> {
    return this.call(RoomReply, 'GET', `/api/rooms/${this.roomId}`);
  }

  async messages(opts: { after?: string; limit?: number } = {}): Promise<Message[]> {
    const params = new URLSearchParams();
    if (opts.after) params.set('after', opts.after);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const query = params.size > 0 ? `?${params}` : '';
    const out = await this.call(
      z.object({ messages: z.array(MessageSchema) }),
      'GET',
      `/api/rooms/${this.roomId}/messages${query}`,
    );
    return out.messages;
  }

  async send(body: Outgoing): Promise<Message> {
    const out = await this.call(
      z.object({ message: MessageSchema }),
      'POST',
      `/api/rooms/${this.roomId}/messages`,
      { json: { recipient_ids: [], ...body } },
    );
    return out.message;
  }

  async setSummary(summary_markdown: string | null): Promise<Room> {
    const out = await this.call(
      z.object({ room: RoomSchema }),
      'PUT',
      `/api/rooms/${this.roomId}/summary`,
      { json: { summary_markdown } },
    );
    return out.room;
  }

  async artifact(artifactId: string): Promise<Artifact> {
    const out = await this.call(
      z.object({ artifact: ArtifactSchema }),
      'GET',
      `/api/rooms/${this.roomId}/artifacts/${artifactId}`,
    );
    return out.artifact;
  }

  upload(opts: {
    absPath: string;
    filename: string;
    mimeType: string;
    description: string;
    approvalId?: string;
  }): Promise<{ artifact: Artifact; message: Message }> {
    return openAsBlob(opts.absPath, { type: opts.mimeType }).then((blob) => {
      const form = new FormData();
      form.append('file', blob, opts.filename);
      form.append('description', opts.description);
      if (opts.approvalId) form.append('approval_id', opts.approvalId);
      return this.call(
        z.object({ artifact: ArtifactSchema, message: MessageSchema }),
        'POST',
        `/api/rooms/${this.roomId}/artifacts`,
        { form, timeoutMs: TRANSFER_MS },
      );
    });
  }

  /** Stream an artifact to a local path. */
  async download(artifactId: string, destPath: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.serverUrl}/api/rooms/${this.roomId}/artifacts/${artifactId}/download`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(TRANSFER_MS),
      });
    } catch (err) {
      throw new ApiError(0, 'network', `download failed: ${errorText(err)}`);
    }
    if (!res.ok) throw await this.toError(res);
    if (!res.body) throw new ApiError(res.status, 'unknown', 'the download had no body');
    await pipeline(
      Readable.fromWeb(res.body as unknown as WebReadableStream),
      createWriteStream(destPath),
    );
  }

  async approvals(status?: ApprovalStatus): Promise<Approval[]> {
    const out = await this.call(
      z.object({ approvals: z.array(ApprovalSchema) }),
      'GET',
      `/api/rooms/${this.roomId}/approvals${status ? `?status=${status}` : ''}`,
    );
    return out.approvals;
  }

  async requestApproval(body: CreateApprovalRequest): Promise<Approval> {
    const out = await this.call(
      z.object({ approval: ApprovalSchema }),
      'POST',
      `/api/rooms/${this.roomId}/approvals`,
      { json: body },
    );
    return out.approval;
  }
}

// ---------------------------------------------------------------------------
// Push channel
// ---------------------------------------------------------------------------

const BACKOFF_START_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const PING_MS = 25_000;
/** Auth and membership failures; retrying cannot help. */
const FATAL_CLOSE = new Map([
  [4001, 'the token was rejected'],
  [4003, 'this token is not a participant of the room'],
  [4004, 'no such room'],
]);

/**
 * The room's event stream. Reconnecting re-sends the same query string, which is
 * itself the subscription, so every reconnect resubscribes.
 */
export class Feed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoffMs = BACKOFF_START_MS;
  private reconnect: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<(frame: ServerFrame) => void>();
  /** Set once the socket gives up for good. */
  fatal: string | null = null;

  constructor(
    private readonly serverUrl: string,
    private readonly roomId: string,
    private readonly token: string,
    private readonly log: (line: string) => void,
  ) {}

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to validated frames; returns an unsubscribe function. */
  on(listener: (frame: ServerFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Best-effort; a dropped status frame must never fail the work it describes. */
  send(frame: ClientFrame): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      /* best-effort */
    }
  }

  /** Resolve with the first frame `match` accepts, or null after the timeout. */
  waitFor<T>(match: (frame: ServerFrame) => T | null, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      const finish = (value: T | null) => {
        unsubscribe();
        clearTimeout(timer);
        resolve(value);
      };
      const unsubscribe = this.on((frame) => {
        try {
          const value = match(frame);
          if (value !== null) finish(value);
        } catch {
          /* a bad matcher must not kill the feed */
        }
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
    });
  }

  private open(): void {
    if (this.stopped || this.fatal) return;
    const url = new URL(this.serverUrl);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/ws';
    url.search = new URLSearchParams({ room_id: this.roomId, token: this.token }).toString();
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = BACKOFF_START_MS;
      this.clearPing();
      this.ping = setInterval(() => this.send({ type: 'ping' }), PING_MS);
    });

    ws.on('message', (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = ServerFrameSchema.safeParse(data);
      if (!parsed.success) return;
      for (const listener of this.listeners) {
        try {
          listener(parsed.data);
        } catch {
          /* a bad listener must not kill the feed */
        }
      }
    });

    ws.on('error', (err) => this.log(`room feed: ${errorText(err)}`));

    ws.on('close', (code) => {
      this.clearPing();
      this.ws = null;
      if (this.stopped) return;
      const reason = FATAL_CLOSE.get(code);
      if (reason) {
        this.fatal = reason;
        this.log(`room feed closed for good: ${reason}`);
        return;
      }
      this.reconnect = setTimeout(() => this.open(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    });
  }

  private clearPing(): void {
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
  }
}
