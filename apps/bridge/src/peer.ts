/**
 * Guest-side loopback endpoint for browser-owned WebRTC.
 *
 * Static UI requests stay here. Only /api, /healthz, and /ws TCP connections
 * are offered to this machine's authenticated browser, one at a time; the
 * browser maps each to a WebRTC data channel. No frame contains a destination.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bindNodeTunnel,
  PEER,
  PeerRoomInviteSchema,
  WEB_CSP,
  type PeerRoomInvite,
} from '@clausroom/protocol';
import { WebSocket, WebSocketServer } from 'ws';
import { log } from './util.js';

export type RoomInvite = PeerRoomInvite;

export interface GuestRelayOptions {
  port: number;
  onJoin: (invite: RoomInvite) => Promise<string>;
}

export interface GuestRelay {
  readonly port: number;
  readonly url: string;
  readonly secret: string;
  close(): Promise<void>;
}

const HEADER_BYTES = 8192;
const WAIT_MS = 30_000;
const CONTROL_BYTES = 8192;

interface Pending {
  socket: net.Socket;
  timer: NodeJS.Timeout;
}

function webDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'web'),
    path.resolve(here, '..', '..', 'web', 'dist'),
  ];
  const root = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'index.html')));
  if (!root) throw new Error('the web UI is not built; run `npm run build` in the Clausroom checkout');
  return root;
}

function contentType(file: string): string {
  const ext = path.extname(file);
  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    }[ext] ?? 'application/octet-stream'
  );
}

function secure(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // A connection classified as local must never later be reused for /api.
  res.setHeader('Connection', 'close');
  res.setHeader('Content-Security-Policy', WEB_CSP);
}

/** Serve only the immutable build; API and room WebSockets never reach here. */
function staticHandler(root: string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    secure(res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.includes('\0')) {
      res.writeHead(400).end();
      return;
    }
    const requested = path.resolve(root, `.${pathname}`);
    if (requested !== root && !requested.startsWith(`${path.resolve(root)}${path.sep}`)) {
      res.writeHead(404).end();
      return;
    }
    const serve = (file: string, fallback = false): void => fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) {
        if (!fallback && !pathname.startsWith('/assets/')) {
          serve(path.join(root, 'index.html'), true);
          return;
        }
        res.writeHead(404).end();
        return;
      }
      res.setHeader('Content-Type', contentType(file));
      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') res.end();
      else {
        const stream = fs.createReadStream(file);
        stream.once('error', () => res.destroy());
        stream.pipe(res);
      }
    });
    serve(requested);
  };
}

/** A browser WebSocket must have come from this exact loopback origin. */
function localBrowser(req: IncomingMessage, port: number, secret: string, url: URL): boolean {
  const host = req.headers.host ?? '';
  const expected = port === 80 ? '127.0.0.1' : `127.0.0.1:${port}`;
  return (
    host === expected &&
    req.headers.origin === `http://${host}` &&
    url.searchParams.get('secret') === secret
  );
}

function send(ws: WebSocket | null, value: unknown): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
}

/** True only for the three fixed Clausroom surfaces that may cross the peer. */
function isRoomRequest(firstLine: string): boolean {
  const match = /^[A-Z]+ (\/\S*) HTTP\/1\.[01]$/.exec(firstLine);
  if (!match?.[1]) return false;
  let pathname: string;
  try {
    pathname = new URL(match[1], 'http://localhost').pathname;
  } catch {
    return false;
  }
  return (
    pathname === '/healthz' ||
    pathname === '/ws' ||
    pathname === '/api' ||
    pathname.startsWith('/api/')
  );
}

export async function startGuestRelay(options: GuestRelayOptions): Promise<GuestRelay> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error(`peer.port must be an integer from 0 to 65535 (got ${options.port})`);
  }
  const root = webDist();
  const secret = randomBytes(32).toString('hex');
  const local = http.createServer(staticHandler(root));
  const controls = new WebSocketServer({ noServer: true, maxPayload: CONTROL_BYTES, perMessageDeflate: false });
  const tunnels = new WebSocketServer({ noServer: true, maxPayload: PEER.CHUNK_BYTES, perMessageDeflate: false });
  const front = net.createServer();
  const sockets = new Set<net.Socket>();
  const innerSockets = new Set<net.Socket>();
  const active = new Set<WebSocket>();
  const pending = new Map<string, Pending>();
  let control: WebSocket | null = null;
  let port = 0;
  let localPort = 0;
  let closing = false;
  let joined: { invite: RoomInvite; token: Promise<string> } | null = null;

  const announce = (id: string): void => send(control, { type: 'tunnel', id });
  const queue = (socket: net.Socket): void => {
    if (pending.size >= PEER.MAX_TUNNELS) {
      socket.destroy();
      return;
    }
    const id = randomBytes(12).toString('hex');
    log(`[clausroom-peer] tunnel ${id.slice(0, 8)}: room request queued`);
    const timer = setTimeout(() => {
      pending.delete(id);
      log(`[clausroom-peer] tunnel ${id.slice(0, 8)}: browser did not claim request`);
      socket.destroy();
    }, WAIT_MS);
    timer.unref();
    pending.set(id, { socket, timer });
    socket.once('close', () => {
      if (pending.get(id)?.socket !== socket) return;
      clearTimeout(timer);
      pending.delete(id);
    });
    announce(id);
  };

  /** Peek only at the request line, then hand the untouched stream to one side. */
  front.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', () => socket.destroy());
    const chunks: Buffer[] = [];
    let size = 0;
    const timeout = setTimeout(() => socket.destroy(), WAIT_MS);
    timeout.unref();
    const sniff = (chunk: Buffer): void => {
      chunks.push(chunk);
      size += chunk.byteLength;
      const raw = Buffer.concat(chunks, size);
      const end = raw.indexOf('\r\n');
      if (end < 0 && size <= HEADER_BYTES) return;
      clearTimeout(timeout);
      socket.pause();
      socket.removeListener('data', sniff);
      if (end < 0 || end > HEADER_BYTES) {
        socket.destroy();
        return;
      }
      socket.unshift(raw);
      if (isRoomRequest(raw.subarray(0, end).toString('latin1'))) queue(socket);
      else {
        const inner = net.createConnection({ host: '127.0.0.1', port: localPort });
        const fail = () => {
          socket.destroy();
          inner.destroy();
        };
        socket.pipe(inner).pipe(socket);
        socket.once('error', fail);
        inner.once('error', fail);
        socket.resume();
      }
    };
    socket.on('data', sniff);
  });

  local.on('connect', (_req, socket) => socket.destroy());
  local.on('connection', (socket) => {
    innerSockets.add(socket);
    socket.once('close', () => innerSockets.delete(socket));
  });
  local.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return socket.destroy();
    }
    if (!localBrowser(req, port, secret, url)) return socket.destroy();
    if (url.pathname === `${PEER.PATH}/control`) {
      return controls.handleUpgrade(req, socket, head, (ws) => {
        ws.on('error', () => undefined);
        if (control?.readyState === WebSocket.OPEN) control.close(4009, 'browser reconnected');
        control = ws;
        for (const id of pending.keys()) announce(id);
        ws.on('message', (raw, binary) => {
          const text = String(raw);
          if (binary || Buffer.byteLength(text) > CONTROL_BYTES) return ws.close(4002, 'bad control frame');
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch {
            return send(ws, { type: 'error', message: 'Unreadable browser handshake.' });
          }
          const message = value as { type?: unknown; invite?: unknown };
          const invite = PeerRoomInviteSchema.safeParse(message.invite);
          if (message.type !== 'join' || !invite.success) {
            return send(ws, { type: 'error', message: 'Invalid browser handshake.' });
          }
          const same =
            joined &&
            joined.invite.room === invite.data.room &&
            joined.invite.human_id === invite.data.human_id &&
            joined.invite.token === invite.data.token &&
            joined.invite.human === invite.data.human &&
            joined.invite.agent === invite.data.agent;
          if (joined && !same) {
            return send(ws, { type: 'error', message: 'This connector already joined another room.' });
          }
          if (!joined || joined.invite.invite !== invite.data.invite) {
            joined = { invite: invite.data, token: options.onJoin(invite.data) };
          }
          const current = joined;
          void current.token.then(
            (token) => send(ws, { type: 'session', token, invite: current.invite.invite }),
            (error: unknown) => {
              if (joined !== current) return;
              log(`[clausroom] could not finish joining: ${error instanceof Error ? error.message : String(error)}`);
              send(ws, { type: 'error', message: 'The local connector could not finish joining.' });
              joined = null;
            },
          );
        });
        ws.once('close', () => {
          if (control === ws) control = null;
        });
      });
    }
    if (url.pathname !== `${PEER.PATH}/tunnel`) return socket.destroy();
    const id = url.searchParams.get('id') ?? '';
    const waiting = pending.get(id);
    if (!waiting || !/^[0-9a-f]{24}$/.test(id)) return socket.destroy();
    tunnels.handleUpgrade(req, socket, head, (ws) => {
      log(`[clausroom-peer] tunnel ${id.slice(0, 8)}: browser bridge open`);
      pending.delete(id);
      clearTimeout(waiting.timer);
      active.add(ws);
      const drop = () => {
        active.delete(ws);
        log(`[clausroom-peer] tunnel ${id.slice(0, 8)}: browser bridge closed`);
      };
      ws.once('close', drop);
      ws.once('error', drop);
      bindNodeTunnel(waiting.socket, ws);
    });
  });

  await new Promise<void>((resolve, reject) => {
    local.once('error', reject);
    local.listen(0, '127.0.0.1', resolve);
  });
  const localAddress = local.address();
  localPort = localAddress && typeof localAddress === 'object' ? localAddress.port : 0;
  try {
    await new Promise<void>((resolve, reject) => {
      front.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(
                `peer.port ${options.port} is already in use; choose another in clausroom.toml`,
              )
            : error,
        ),
      );
      front.listen(options.port, '127.0.0.1', resolve);
    });
  } catch (error) {
    controls.close();
    tunnels.close();
    await new Promise<void>((resolve) => local.close(() => resolve()));
    throw error;
  }
  const address = front.address();
  port = address && typeof address === 'object' ? address.port : options.port;
  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    secret,
    close: async () => {
      if (closing) return;
      closing = true;
      control?.terminate();
      for (const ws of active) ws.terminate();
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.socket.destroy();
      }
      pending.clear();
      for (const socket of sockets) socket.destroy();
      for (const socket of innerSockets) socket.destroy();
      controls.close();
      tunnels.close();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await new Promise<void>((resolve) => local.close(() => resolve()));
    },
  };
}
