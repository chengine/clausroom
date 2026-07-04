/**
 * WebSocket hub: GET /ws?room_id=<id>&token=<session-or-bridge-token>.
 *
 * Close codes (docs/API-CONTRACT.md §8): 4001 bad/missing/expired token,
 * 4003 not a participant / bridge token for a different room, 4004 unknown room.
 * Client -> server frames: {"type":"ping"} (answered with pong) and
 * {"type":"status","state":"working"|"idle"} (agent activity report — honored
 * only for agent-kind users, silently ignored otherwise). Everything else gets
 * an error frame. All mutations happen over REST.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  DEFAULTS,
  WsClientFrameSchema,
  type ActivityState,
  type UserKind,
  type WsServerFrame,
} from '@clausroom/protocol';
import { resolveApiToken } from './auth.js';
import { toParticipant, toRoom, type Store } from './db.js';
import type { ServerConfig } from './env.js';

interface Conn {
  ws: WebSocket;
  roomId: string;
  userId: string;
  userKind: UserKind;
  isAlive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly rooms = new Map<string, Set<Conn>>();
  /**
   * Ephemeral per-user agent activity ('working' pills), keyed
   * `<roomId>:<userId>`. An entry exists iff the user is 'working' (idle is
   * the default state); its timer auto-reverts to idle after
   * DEFAULTS.ACTIVITY_IDLE_TIMEOUT_MS without a refreshing status frame.
   * Never persisted — no DB row, and the hello frame carries no activity info.
   */
  private readonly activity = new Map<string, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly config: ServerConfig,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.handleUpgrade(req, socket, head, url);
    });
    this.heartbeat = setInterval(() => this.pingAll(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  /** Send a frame to every open socket in the room. */
  broadcast(roomId: string, frame: WsServerFrame): void {
    const conns = this.rooms.get(roomId);
    if (!conns || conns.size === 0) return;
    const payload = JSON.stringify(frame);
    for (const conn of conns) {
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload);
    }
  }

  /** Unique user ids with >=1 open socket in the room. */
  presence(roomId: string): string[] {
    const conns = this.rooms.get(roomId);
    if (!conns) return [];
    return [...new Set([...conns].map((c) => c.userId))];
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const timer of this.activity.values()) clearTimeout(timer);
    this.activity.clear();
    for (const conns of this.rooms.values()) {
      for (const conn of conns) conn.ws.terminate();
    }
    this.rooms.clear();
    this.wss.close();
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const token = url.searchParams.get('token') ?? '';
      const roomId = url.searchParams.get('room_id') ?? '';

      const auth = resolveApiToken(this.store, token, this.config.sessionTtlDays);
      if (auth === 'expired') {
        ws.close(4001, 'expired session token');
        return;
      }
      if (!auth) {
        ws.close(4001, 'bad or missing token');
        return;
      }
      const room = this.store.getRoom(roomId);
      if (!room) {
        ws.close(4004, 'unknown room');
        return;
      }
      if (auth.tokenKind === 'bridge' && auth.tokenRow.room_id !== room.id) {
        ws.close(4003, 'bridge token is scoped to a different room');
        return;
      }
      const participant = this.store.getParticipant(room.id, auth.user.id);
      if (!participant) {
        ws.close(4003, 'not a participant of this room');
        return;
      }

      this.register(ws, room.id, auth.user.id, auth.user.kind);
    });
  }

  private register(ws: WebSocket, roomId: string, userId: string, userKind: UserKind): void {
    let conns = this.rooms.get(roomId);
    if (!conns) {
      conns = new Set<Conn>();
      this.rooms.set(roomId, conns);
    }
    const before = this.presence(roomId);
    const conn: Conn = { ws, roomId, userId, userKind, isAlive: true };
    conns.add(conn);

    ws.on('pong', () => {
      conn.isAlive = true;
    });
    ws.on('message', (data) => this.onClientFrame(conn, data));
    const cleanup = () => this.unregister(conn);
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    // hello frame
    const room = this.store.getRoom(roomId);
    if (!room) {
      ws.close(4004, 'unknown room');
      return;
    }
    const participants = this.store
      .listParticipants(roomId)
      .map(({ participant, user }) => toParticipant(participant, user));
    const hello: WsServerFrame = {
      type: 'hello',
      room: toRoom(room, this.config),
      participants,
      presence: this.presence(roomId),
      latest_message_id: this.store.latestMessageId(roomId),
    };
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(hello));

    // Presence broadcast when the online set changed (first socket for user).
    if (!before.includes(userId)) this.broadcastPresence(roomId);
  }

  private unregister(conn: Conn): void {
    const conns = this.rooms.get(conn.roomId);
    if (!conns || !conns.has(conn)) return;
    conns.delete(conn);
    if (conns.size === 0) this.rooms.delete(conn.roomId);
    const stillOnline = this.presence(conn.roomId).includes(conn.userId);
    if (!stillOnline) {
      this.broadcastPresence(conn.roomId);
      // Last socket closed: revert (and broadcast) working -> idle immediately.
      this.setActivity(conn.roomId, conn.userId, 'idle');
    }
  }

  private broadcastPresence(roomId: string): void {
    this.broadcast(roomId, { type: 'presence', online_user_ids: this.presence(roomId) });
  }

  private onClientFrame(conn: Conn, data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      this.sendError(conn.ws, 'Client frames must be JSON.');
      return;
    }
    const frame = WsClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      this.sendError(
        conn.ws,
        'Unsupported client frame; only {"type":"ping"} and {"type":"status"} are accepted.',
      );
      return;
    }
    if (frame.data.type === 'ping') {
      if (conn.ws.readyState === WebSocket.OPEN) {
        const pong: WsServerFrame = { type: 'pong' };
        conn.ws.send(JSON.stringify(pong));
      }
      return;
    }
    // status frame: honored only for agent-kind users; silently ignored
    // otherwise (valid frame, no error, no effect).
    if (conn.userKind !== 'agent') return;
    this.setActivity(conn.roomId, conn.userId, frame.data.state);
  }

  /**
   * Apply an activity state, broadcasting only on change. A repeated
   * 'working' report refreshes the auto-idle timer without rebroadcasting.
   */
  private setActivity(roomId: string, userId: string, state: ActivityState): void {
    const key = `${roomId}:${userId}`;
    const existing = this.activity.get(key);
    if (state === 'working') {
      if (existing) clearTimeout(existing);
      const timer = setTimeout(
        () => this.setActivity(roomId, userId, 'idle'),
        DEFAULTS.ACTIVITY_IDLE_TIMEOUT_MS,
      );
      timer.unref();
      this.activity.set(key, timer);
      if (!existing) this.broadcastActivity(roomId, userId, 'working');
      return;
    }
    if (existing) {
      clearTimeout(existing);
      this.activity.delete(key);
      this.broadcastActivity(roomId, userId, 'idle');
    }
  }

  private broadcastActivity(roomId: string, userId: string, state: ActivityState): void {
    this.broadcast(roomId, { type: 'activity', payload: { user_id: userId, state } });
  }

  private sendError(ws: WebSocket, message: string): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    const frame: WsServerFrame = { type: 'error', code: 'validation', message };
    ws.send(JSON.stringify(frame));
  }

  private pingAll(): void {
    for (const conns of this.rooms.values()) {
      for (const conn of conns) {
        if (!conn.isAlive) {
          conn.ws.terminate();
          continue;
        }
        conn.isAlive = false;
        try {
          conn.ws.ping();
        } catch {
          conn.ws.terminate();
        }
      }
    }
  }
}
