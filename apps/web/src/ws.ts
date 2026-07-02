/**
 * WebSocket client for /ws with exponential-backoff reconnect.
 *
 * Frames are validated with WsServerFrameSchema before they reach the app.
 * Auth-style close codes (4001/4003/4004) stop reconnecting — a bad token
 * will not fix itself. On every (re)connect the server sends a `hello`
 * frame; the room state layer uses it to catch up missed messages via REST.
 */
import { WsServerFrameSchema, type WsServerFrame } from '@clausroom/protocol';
import { getServerBase } from './storage.js';

export type ConnectionState = 'connecting' | 'online' | 'reconnecting' | 'denied' | 'stopped';

export interface RoomSocketHandlers {
  onFrame: (frame: WsServerFrame) => void;
  onState: (state: ConnectionState) => void;
}

const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 15_000;
const PING_INTERVAL_MS = 25_000;
const DENIED_CLOSE_CODES = new Set([4001, 4003, 4004]);

function wsUrl(roomId: string, token: string): string {
  const httpBase = getServerBase() || window.location.origin;
  const base = httpBase.replace(/^http/i, 'ws');
  const params = new URLSearchParams({ room_id: roomId, token });
  return `${base}/ws?${params.toString()}`;
}

export class RoomSocket {
  private readonly roomId: string;
  private readonly token: string;
  private readonly handlers: RoomSocketHandlers;
  private ws: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private everConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(roomId: string, token: string, handlers: RoomSocketHandlers) {
    this.roomId = roomId;
    this.token = token;
    this.handlers = handlers;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onopen = null;
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    }
    this.handlers.onState('stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    this.handlers.onState(this.everConnected ? 'reconnecting' : 'connecting');

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl(this.roomId, this.token));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.stopped || this.ws !== ws) return;
      this.attempts = 0;
      this.everConnected = true;
      this.handlers.onState('online');
      this.startPing();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (this.stopped || this.ws !== ws) return;
      if (typeof event.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = WsServerFrameSchema.safeParse(raw);
      if (parsed.success) this.handlers.onFrame(parsed.data);
    };

    ws.onclose = (event: CloseEvent) => {
      if (this.ws === ws) this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (DENIED_CLOSE_CODES.has(event.code)) {
        this.handlers.onState('denied');
        return;
      }
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(this.attempts, 6));
    const delay = exp / 2 + Math.random() * (exp / 2);
    this.attempts += 1;
    this.handlers.onState('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
