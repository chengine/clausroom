/**
 * The push channel: GET /ws?room_id=<id>&token=<session-or-bridge-token>.
 *
 * Clients only ever send `{"type":"ping"}` or, for agents,
 * `{"type":"status","state":"working"|"idle"}`. Every mutation goes over REST.
 * Close codes: 4001 bad token, 4003 not a participant, 4004 unknown room.
 */
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import {
  bindNodeTunnel,
  ClientFrameSchema,
  LIMITS,
  PEER,
  type ActivityState,
  type ServerFrame,
} from '@clausroom/protocol';
import type { Store } from './db.js';
import { resolveToken } from './room.js';

interface Conn {
  ws: WebSocket;
  roomId: string;
  userId: string;
  isAgent: boolean;
  alive: boolean;
}

const HEARTBEAT_MS = 30_000;

export class Hub {
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: LIMITS.CLIENT_FRAME_BYTES,
    perMessageDeflate: false,
  });
  private readonly peerWss = new WebSocketServer({
    noServer: true,
    maxPayload: PEER.CHUNK_BYTES,
    perMessageDeflate: false,
  });
  private readonly conns = new Set<Conn>();
  private readonly tunnels = new Set<WebSocket>();
  /**
   * An entry exists only while that agent is "working" (idle is the default).
   * Its timer reverts to idle without a refreshing status frame, so a crashed
   * agent does not leave the pill spinning forever.
   */
  private readonly working = new Map<string, NodeJS.Timeout>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly store: Store,
    private readonly peerSecret?: string,
  ) {}

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        return socket.destroy();
      }
      if (url.pathname === '/ws') return this.upgrade(req, socket, head, url);
      if (url.pathname === `${PEER.PATH}/tunnel`) {
        return this.peerUpgrade(server, req, socket, head, url);
      }
      socket.destroy();
    });
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Send a frame to every open socket in the room. */
  send(roomId: string, frame: ServerFrame): void {
    const payload = JSON.stringify(frame);
    for (const conn of this.conns) {
      if (conn.roomId === roomId && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(payload);
    }
  }

  /** User ids with at least one open socket in the room. */
  online(roomId: string): string[] {
    return [...new Set([...this.conns].filter((c) => c.roomId === roomId).map((c) => c.userId))];
  }

  /** Immediately remove sockets authenticated as a user whose tokens changed. */
  disconnectUser(userId: string): void {
    for (const conn of [...this.conns]) {
      if (conn.userId !== userId) continue;
      this.drop(conn);
      conn.ws.close(4001, 'token rotated');
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const timer of this.working.values()) clearTimeout(timer);
    for (const conn of this.conns) conn.ws.terminate();
    for (const ws of this.tunnels) ws.terminate();
    this.conns.clear();
    this.tunnels.clear();
    this.wss.close();
    this.peerWss.close();
  }

  /** One authenticated browser tunnel, hard-wired to this room server. */
  private peerUpgrade(
    server: HttpServer,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
  ): void {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    const host = req.headers.host ?? '';
    const origin = req.headers.origin ?? '';
    const expectedHost = port === 80 ? '127.0.0.1' : `127.0.0.1:${port}`;
    if (
      !this.peerSecret ||
      url.searchParams.get('secret') !== this.peerSecret ||
      host !== expectedHost ||
      origin !== `http://${host}` ||
      this.tunnels.size >= PEER.MAX_TUNNELS
    ) {
      socket.destroy();
      return;
    }
    this.peerWss.handleUpgrade(req, socket, head, (ws) => {
      this.tunnels.add(ws);
      const drop = () => this.tunnels.delete(ws);
      ws.once('close', drop);
      ws.once('error', drop);
      bindNodeTunnel(net.createConnection({ host: '127.0.0.1', port }), ws);
    });
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
    if (this.conns.size >= LIMITS.WS_CONNECTIONS) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const resolved = resolveToken(this.store, url.searchParams.get('token') ?? '');
      if (!resolved) return ws.close(4001, 'bad or missing token');
      const room = this.store.room(url.searchParams.get('room_id') ?? '');
      if (!room) return ws.close(4004, 'unknown room');
      if (resolved.tokenKind === 'bridge' && resolved.token.room_id !== room.id) {
        return ws.close(4003, 'bridge token belongs to a different room');
      }
      if (!this.store.participant(room.id, resolved.user.id)) {
        return ws.close(4003, 'not a participant of this room');
      }

      const conn: Conn = {
        ws,
        roomId: room.id,
        userId: resolved.user.id,
        isAgent: resolved.user.kind === 'agent',
        alive: true,
      };
      const wasOnline = this.online(room.id).includes(conn.userId);
      this.conns.add(conn);

      ws.on('pong', () => {
        conn.alive = true;
      });
      ws.on('message', (data) => this.onFrame(conn, data));
      const drop = () => this.drop(conn);
      ws.on('close', drop);
      ws.on('error', drop);

      ws.send(
        JSON.stringify({
          type: 'hello',
          room,
          participants: this.store.participants(room.id),
          online_user_ids: this.online(room.id),
        } satisfies ServerFrame),
      );
      if (!wasOnline) this.sendPresence(room.id);
    });
  }

  private drop(conn: Conn): void {
    if (!this.conns.delete(conn)) return;
    if (this.online(conn.roomId).includes(conn.userId)) return;
    this.sendPresence(conn.roomId);
    // Their last socket closed: they are definitively not working any more.
    this.setActivity(conn.roomId, conn.userId, 'idle');
  }

  private sendPresence(roomId: string): void {
    this.send(roomId, { type: 'presence', online_user_ids: this.online(roomId) });
  }

  private onFrame(conn: Conn, data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      parsed = null;
    }
    const frame = ClientFrameSchema.safeParse(parsed);
    if (!frame.success) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(
          JSON.stringify({
            type: 'error',
            code: 'validation',
            message: 'Only {"type":"ping"} and {"type":"status"} are accepted.',
          } satisfies ServerFrame),
        );
      }
      return;
    }
    if (frame.data.type === 'ping') {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(JSON.stringify({ type: 'pong' } satisfies ServerFrame));
      }
      return;
    }
    // Status reports are meaningful only from agents; ignored from anyone else.
    if (conn.isAgent) this.setActivity(conn.roomId, conn.userId, frame.data.state);
  }

  /** Broadcast only on a real change; a repeated 'working' just refreshes the timer. */
  private setActivity(roomId: string, userId: string, state: ActivityState): void {
    const key = `${roomId}:${userId}`;
    const existing = this.working.get(key);
    if (existing) clearTimeout(existing);
    if (state === 'working') {
      const timer = setTimeout(
        () => this.setActivity(roomId, userId, 'idle'),
        LIMITS.ACTIVITY_IDLE_MS,
      );
      timer.unref();
      this.working.set(key, timer);
      if (!existing) this.send(roomId, { type: 'activity', user_id: userId, state: 'working' });
      return;
    }
    if (existing) {
      this.working.delete(key);
      this.send(roomId, { type: 'activity', user_id: userId, state: 'idle' });
    }
  }

  private ping(): void {
    for (const conn of this.conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }
}
