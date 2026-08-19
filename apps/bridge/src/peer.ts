/**
 * The direct link between the two machines.
 *
 * The host opens no public port. It makes a WebRTC offer and maps authenticated
 * data channels to one fixed loopback address — the room server, and nothing
 * else. The guest runs a loopback-only TCP proxy, so their browser and their
 * agent keep speaking ordinary HTTP and WebSocket.
 *
 * STUN only discovers addresses. TURN URLs are rejected and a relayed candidate
 * pair is refused: if the two networks cannot reach each other directly, this
 * fails instead of routing your room through someone else's server.
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import type {
  DataChannel,
  DescriptionType,
  PeerConnection,
  SelectedCandidateInfo,
} from 'node-datachannel';
import { deferred, log, withTimeout, type Deferred } from './util.js';

const VERSION = 1;
const OFFER_PREFIX = 'clausroom-offer-v1.';
const ANSWER_PREFIX = 'clausroom-answer-v1.';
const CONTROL = 'clausroom-control-v1';
const TUNNEL = 'clausroom-tcp-v1';
const TUNNEL_LABEL = `${TUNNEL}:`;

const SIGNAL_MAX_BYTES = 512 * 1024;
const GATHER_TIMEOUT_MS = 30_000;
const AUTH_TIMEOUT_MS = 5 * 60_000;
const CHUNK_BYTES = 16 * 1024;
const CHANNEL_HIGH = 1024 * 1024;
const CHANNEL_LOW = 256 * 1024;
const QUEUE_MAX = 8 * 1024 * 1024;
const MAX_TUNNELS = 128;

/** One byte of framing keeps TCP half-close semantics across a data channel. */
const DATA = 1;
const END = 2;
const RESET = 3;

interface Candidate {
  candidate: string;
  mid: string;
}

/**
 * What the host puts inside the offer so the guest needs nothing else: the room
 * id, their one-time browser invite, their agent's room token, and the names the
 * host gave them. Anyone holding the offer can join, so it is a private
 * one-session invitation and must be sent over a channel you trust.
 */
export interface RoomInvite {
  room: string;
  invite: string;
  token: string;
  human: string;
  agent: string;
}

interface Signal {
  v: typeof VERSION;
  kind: 'offer' | 'answer';
  session: string;
  sdp: string;
  candidates: Candidate[];
  room?: RoomInvite;
}

/** Only a loopback address, and only the port the room server listens on. */
interface Target {
  host: '127.0.0.1' | '::1';
  port: number;
  url: string;
}

export interface HostOptions {
  port: number;
  stun: string[];
  invite: RoomInvite;
}

export interface JoinOptions {
  port: number;
  stun: string[];
  onReady: (details: { url: string; invite: RoomInvite }) => Promise<void>;
}

/** Machine-readable lines the launcher and the tests read off stdout. */
function emit(name: string, value: string): void {
  process.stdout.write(`${name} ${value}\n`);
}

function target(port: number): Target {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`the room server port must be 1-65535 (got ${port})`);
  }
  return { host: '127.0.0.1', port, url: `http://127.0.0.1:${port}` };
}

function checkStun(urls: string[]): string[] {
  for (const url of urls) {
    if (!url.startsWith('stun:') && !url.startsWith('stuns:')) {
      throw new Error(`peer mode allows STUN only; TURN relays are refused (got ${url})`);
    }
  }
  return urls;
}

const isRoomInvite = (value: unknown): value is RoomInvite => {
  const r = value as Partial<RoomInvite> | null;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.room === 'string' &&
    /^room_[0-9a-f]{24}$/.test(r.room) &&
    typeof r.invite === 'string' &&
    /^arit_[0-9a-f]{32}$/.test(r.invite) &&
    typeof r.token === 'string' &&
    /^arbt_[0-9a-f]{32}$/.test(r.token) &&
    typeof r.human === 'string' &&
    r.human.length > 0 &&
    r.human.length <= 100 &&
    typeof r.agent === 'string' &&
    r.agent.length > 0 &&
    r.agent.length <= 100
  );
};

function encode(signal: Signal): string {
  const prefix = signal.kind === 'offer' ? OFFER_PREFIX : ANSWER_PREFIX;
  return prefix + Buffer.from(JSON.stringify(signal), 'utf8').toString('base64url');
}

/** Parse one pasted code, rejecting anything that is not the expected shape. */
function decode(raw: string, kind: Signal['kind']): Signal {
  const label = kind === 'offer' ? 'CLAUSROOM_PEER_OFFER ' : 'CLAUSROOM_PEER_ANSWER ';
  const trimmed = raw.trim();
  const text = trimmed.startsWith(label) ? trimmed.slice(label.length).trim() : trimmed;
  if (text.length > SIGNAL_MAX_BYTES * 2) throw new Error(`that ${kind} is too long`);

  const prefix = kind === 'offer' ? OFFER_PREFIX : ANSWER_PREFIX;
  if (!text.startsWith(prefix)) throw new Error(`a clausroom ${kind} starts with ${prefix}`);
  const decoded = Buffer.from(text.slice(prefix.length), 'base64url');
  if (decoded.byteLength === 0 || decoded.byteLength > SIGNAL_MAX_BYTES) {
    throw new Error(`that ${kind} is the wrong size`);
  }

  let value: Partial<Signal>;
  try {
    value = JSON.parse(decoded.toString('utf8')) as Partial<Signal>;
  } catch {
    throw new Error(`that ${kind} is not readable`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    value.v !== VERSION ||
    value.kind !== kind ||
    typeof value.session !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test(value.session) ||
    typeof value.sdp !== 'string' ||
    value.sdp.length > SIGNAL_MAX_BYTES ||
    !value.sdp.includes('a=fingerprint:') ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 256 ||
    value.candidates.some(
      (c) =>
        typeof c !== 'object' ||
        c === null ||
        typeof c.candidate !== 'string' ||
        c.candidate.length > 4096 ||
        typeof c.mid !== 'string' ||
        c.mid.length > 64,
    ) ||
    (value.room !== undefined && (kind !== 'offer' || !isRoomInvite(value.room)))
  ) {
    throw new Error(`that ${kind} is malformed`);
  }
  return value as Signal;
}

/**
 * Keep prompting until a pasted signal parses. A mistyped paste must not tear
 * the room down, and there is no deadline on either side: carrying a code across
 * to another person is a human step.
 */
async function readSignal(
  kind: Signal['kind'],
  check?: (signal: Signal) => void,
): Promise<Signal> {
  const rl = readline.createInterface({ input: stdin, output: stderr });
  try {
    for (;;) {
      const raw = await rl.question(`\nPaste the ${kind} here, then press Enter:\n> `);
      try {
        const signal = decode(raw, kind);
        check?.(signal);
        return signal;
      } catch (err) {
        log(`that ${kind} was not accepted: ${err instanceof Error ? err.message : String(err)}`);
        log(`still waiting — paste the right ${kind} and try again`);
      }
    }
  } finally {
    rl.close();
  }
}

interface Gathered {
  candidates: Candidate[];
  description: Deferred<{ sdp: string; type: DescriptionType }>;
  complete: Deferred<void>;
}

function gather(pc: PeerConnection): Gathered {
  const candidates: Candidate[] = [];
  const description = deferred<{ sdp: string; type: DescriptionType }>();
  const complete = deferred<void>();
  pc.onLocalDescription((sdp, type) => description.resolve({ sdp, type }));
  pc.onLocalCandidate((candidate, mid) => candidates.push({ candidate, mid }));
  pc.onGatheringStateChange((state) => {
    if (state === 'complete') complete.resolve();
  });
  return { candidates, description, complete };
}

/** "host/UDP=2, srflx/UDP=1" — enough to see what ICE actually found. */
function summarize(candidates: Candidate[]): string {
  const counts = new Map<string, number>();
  for (const { candidate } of candidates) {
    const transport = candidate.match(/\s(UDP|TCP)\s/i)?.[1]?.toUpperCase() ?? '?';
    const type = candidate.match(/\styp\s+([A-Za-z0-9_-]+)/i)?.[1]?.toLowerCase() ?? '?';
    const key = `${type}/${transport}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts.size === 0
    ? 'none'
    : [...counts]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, count]) => `${key}=${count}`)
        .join(', ');
}

async function buildSignal(
  pc: PeerConnection,
  gathered: Gathered,
  kind: Signal['kind'],
  session: string,
  room?: RoomInvite,
): Promise<Signal> {
  const [{ sdp, type }] = await Promise.all([
    withTimeout(gathered.description.promise, GATHER_TIMEOUT_MS, 'local description'),
    withTimeout(gathered.complete.promise, GATHER_TIMEOUT_MS, 'ICE gathering'),
  ]);
  if (type !== kind) throw new Error(`WebRTC produced ${type}, expected ${kind}`);
  log(`found ICE candidates: ${summarize(gathered.candidates)}`);
  return {
    v: VERSION,
    kind,
    session,
    sdp: pc.localDescription()?.sdp ?? sdp,
    candidates: gathered.candidates,
    ...(kind === 'offer' && room ? { room } : {}),
  };
}

function applySignal(pc: PeerConnection, signal: Signal): void {
  pc.setRemoteDescription(signal.sdp, signal.kind);
  for (const { candidate, mid } of signal.candidates) pc.addRemoteCandidate(candidate, mid);
}

function frame(type: number, payload?: Buffer): Buffer {
  if (!payload || payload.byteLength === 0) return Buffer.from([type]);
  const out = Buffer.allocUnsafe(payload.byteLength + 1);
  out[0] = type;
  payload.copy(out, 1);
  return out;
}

/**
 * Join one data channel to one TCP socket, in both directions, with flow control
 * on both sides. The tunnel never interprets the bytes it carries: they are not
 * a path, a command, or a filename to it.
 */
function bind(dc: DataChannel, socket: net.Socket, onDone: () => void): void {
  let open = dc.isOpen();
  let localEnded = false;
  let remoteEnded = false;
  let done = false;
  let queuedBytes = 0;
  let retry: NodeJS.Timeout | undefined;
  const queue: Buffer[] = [];

  // The native channel can be torn down by the peer at any moment, so every
  // query about it has to tolerate throwing.
  const isOpen = (): boolean => {
    try {
      return dc.isOpen();
    } catch {
      return false;
    }
  };
  const buffered = (): number => {
    try {
      return dc.bufferedAmount();
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const finish = (reset: boolean): void => {
    if (done) return;
    done = true;
    if (retry) clearTimeout(retry);
    try {
      if (reset && isOpen()) dc.sendMessageBinary(frame(RESET));
      dc.close();
    } catch {
      /* already gone */
    }
    socket.destroy();
    onDone();
  };

  const applyBackpressure = (): void => {
    if (!done && open && queuedBytes < CHANNEL_HIGH && buffered() < CHANNEL_HIGH) socket.resume();
    else socket.pause();
  };

  const closeWhenDrained = (): void => {
    if (!localEnded || !remoteEnded || queue.length > 0 || done) return;
    if (buffered() > 0) {
      scheduleRetry();
      return;
    }
    finish(false);
  };

  const scheduleRetry = (): void => {
    if (retry || done) return;
    retry = setTimeout(() => {
      retry = undefined;
      pump();
    }, 10);
    retry.unref();
  };

  const pump = (): void => {
    if (done || !open) {
      applyBackpressure();
      return;
    }
    while (queue.length > 0) {
      if (buffered() >= CHANNEL_HIGH) {
        // Wait for the channel to drain. onBufferedAmountLow normally wakes us;
        // the timer is insurance against a missed callback stalling the tunnel.
        scheduleRetry();
        break;
      }
      const next = queue[0];
      if (!next) break;
      try {
        // A false return means libdatachannel buffered the message instead of
        // sending it right away. It is queued either way, so the frame must be
        // dropped from our queue — re-sending it would duplicate bytes in the
        // stream and corrupt whatever is being carried.
        dc.sendMessageBinary(next);
      } catch {
        finish(false);
        return;
      }
      queue.shift();
      queuedBytes -= next.byteLength;
    }
    applyBackpressure();
    closeWhenDrained();
  };

  const enqueue = (type: number, payload?: Buffer): boolean => {
    if (done) return false;
    const out = frame(type, payload);
    if (queuedBytes + out.byteLength > QUEUE_MAX) {
      log('closing a tunnel whose send queue outgrew its memory limit');
      finish(true);
      return false;
    }
    queue.push(out);
    queuedBytes += out.byteLength;
    pump();
    return !done;
  };

  socket.pause();
  dc.setBufferedAmountLowThreshold(CHANNEL_LOW);
  dc.onOpen(() => {
    open = true;
    pump();
  });
  dc.onBufferedAmountLow(pump);
  dc.onError((why) => {
    log(`data channel error: ${why}`);
    finish(false);
  });
  dc.onClosed(() => {
    if (done) return;
    done = true;
    socket.destroy();
    onDone();
  });
  dc.onMessage((raw) => {
    const buffer = typeof raw === 'string' ? null : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (!buffer || buffer.byteLength < 1) return finish(true);
    switch (buffer[0]) {
      case DATA: {
        if (remoteEnded || buffer.byteLength === 1 || buffer.byteLength > CHUNK_BYTES + 1) {
          return finish(true);
        }
        socket.write(buffer.subarray(1));
        if (socket.writableLength > QUEUE_MAX) {
          log('closing a tunnel whose receiver outgrew its memory limit');
          finish(true);
        }
        return;
      }
      case END:
        if (buffer.byteLength !== 1 || remoteEnded) return finish(true);
        remoteEnded = true;
        socket.end();
        return closeWhenDrained();
      case RESET:
        return finish(false);
      default:
        return finish(true);
    }
  });

  socket.on('data', (chunk: Buffer) => {
    for (let at = 0; at < chunk.byteLength; at += CHUNK_BYTES) {
      if (!enqueue(DATA, chunk.subarray(at, at + CHUNK_BYTES))) return;
    }
  });
  socket.on('end', () => {
    localEnded = true;
    enqueue(END);
    closeWhenDrained();
  });
  socket.on('error', (err) => {
    log(`tunnel socket error: ${err.message}`);
    finish(true);
  });
  socket.on('close', (hadError) => {
    if (!done && (hadError || (!localEnded && !remoteEnded))) finish(true);
    else closeWhenDrained();
  });

  pump();
}

interface Lifecycle {
  connected: Deferred<void>;
  closed: Deferred<void>;
  failed: Deferred<never>;
}

function lifecycle(pc: PeerConnection): Lifecycle {
  const connected = deferred<void>();
  const closed = deferred<void>();
  const failed = deferred<never>();
  // ICE can fail while a human is still carrying the answer across. Mark the
  // rejection handled now; every caller still races the original promise.
  void failed.promise.catch(() => undefined);
  pc.onStateChange((state) => {
    log(`connection: ${state}`);
    if (state === 'connected') connected.resolve();
    else if (state === 'closed') closed.resolve();
    else if (state === 'failed') {
      failed.reject(
        new Error(
          'the direct connection failed: ICE found no usable path between the two networks',
        ),
      );
    }
  });
  return { connected, closed, failed };
}

/** Report the chosen path, and refuse it outright if it turned out to be a relay. */
function reportPath(pc: PeerConnection): void {
  const pair = pc.getSelectedCandidatePair();
  if (!pair) {
    emit('CLAUSROOM_PEER_PATH', 'direct');
    return;
  }
  if (pair.local.type === 'relay' || pair.remote.type === 'relay') {
    pc.close();
    throw new Error('refusing a relayed connection: peer mode is direct-only');
  }
  const describe = (c: SelectedCandidateInfo) =>
    `${c.type}/${c.transportType} ${c.address}:${c.port}`;
  emit('CLAUSROOM_PEER_PATH', `direct ${describe(pair.local)} -> ${describe(pair.remote)}`);
}

function onShutdown(close: () => void): () => void {
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  return () => {
    process.removeListener('SIGINT', close);
    process.removeListener('SIGTERM', close);
  };
}

async function loadRtc(): Promise<typeof import('node-datachannel').default> {
  try {
    return (await import('node-datachannel')).default;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      throw new Error(
        'the direct connection needs the optional node-datachannel package; reinstall clausroom with optional dependencies enabled',
      );
    }
    throw err;
  }
}

function connection(rtc: Awaited<ReturnType<typeof loadRtc>>, name: string, stun: string[]) {
  return new rtc.PeerConnection(name, {
    iceServers: stun,
    enableIceTcp: true,
    disableAutoNegotiation: true,
    maxMessageSize: 256 * 1024,
  });
}

/** A short handshake binding the connection to the session in the offer. */
function hello(session: string, role: 'host' | 'join'): string {
  return JSON.stringify({ v: VERSION, session, role });
}

function checkHello(raw: unknown, session: string, expect: 'host' | 'join'): void {
  if (typeof raw !== 'string' || raw.length > 1024) throw new Error('bad peer greeting');
  const parsed = JSON.parse(raw) as { v?: unknown; session?: unknown; role?: unknown };
  if (parsed.v !== VERSION || parsed.session !== session || parsed.role !== expect) {
    throw new Error('this peer belongs to a different session');
  }
}

/** Offer, wait for the answer, then forward only to the fixed loopback port. */
export async function peerHost(options: HostOptions): Promise<void> {
  const fixed = target(options.port);
  const stun = checkStun(options.stun);
  const rtc = await loadRtc();
  const session = randomBytes(18).toString('base64url');
  const pc = connection(rtc, 'clausroom-host', stun);
  const life = lifecycle(pc);
  const gathered = gather(pc);
  const authorized = deferred<void>();
  void authorized.promise.catch(() => undefined);
  let authenticated = false;
  let tunnels = 0;

  const control = pc.createDataChannel(CONTROL, { protocol: CONTROL });
  control.onMessage((raw) => {
    if (authenticated) return;
    try {
      checkHello(raw, session, 'join');
      authenticated = true;
      if (!control.sendMessage(hello(session, 'host'))) throw new Error('could not reply');
      authorized.resolve();
    } catch (err) {
      authorized.reject(err instanceof Error ? err : new Error(String(err)));
      pc.close();
    }
  });
  control.onError((why) => authorized.reject(new Error(`control channel failed: ${why}`)));
  control.onClosed(() => {
    if (!authenticated) authorized.reject(new Error('the peer left before authenticating'));
  });

  pc.onDataChannel((dc) => {
    if (
      !authenticated ||
      dc.getProtocol() !== TUNNEL ||
      !dc.getLabel().startsWith(TUNNEL_LABEL) ||
      tunnels >= MAX_TUNNELS
    ) {
      dc.close();
      return;
    }
    tunnels += 1;
    bind(dc, net.createConnection({ host: fixed.host, port: fixed.port }), () => {
      tunnels -= 1;
    });
  });

  const detach = onShutdown(() => pc.close());
  try {
    pc.setLocalDescription('offer');
    const offer = await buildSignal(pc, gathered, 'offer', session, options.invite);
    log(`forwarding only to ${fixed.url}`);
    log(stun.length === 0 ? 'STUN is off; trying local addresses only' : `STUN: ${stun.join(', ')}`);
    emit('CLAUSROOM_PEER_OFFER', encode(offer));

    const answer = await readSignal('answer', (signal) => {
      if (signal.session !== session) throw new Error('that answer is for a different session');
    });
    applySignal(pc, answer);

    await withTimeout(
      Promise.race([authorized.promise, life.failed.promise]),
      AUTH_TIMEOUT_MS,
      'peer authentication',
    );
    await life.connected.promise;
    reportPath(pc);
    emit('CLAUSROOM_PEER_READY', fixed.url);
    await Promise.race([life.closed.promise, life.failed.promise]);
  } finally {
    detach();
    pc.close();
    rtc.cleanup();
  }
}

/** Take an offer, answer it, and serve the room on a loopback port. */
export async function peerJoin(options: JoinOptions): Promise<void> {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('peer.port must be an integer from 0 to 65535');
  }
  const stun = checkStun(options.stun);
  const offer = await readSignal('offer');
  if (!offer.room) {
    throw new Error('that offer carries no room credentials — ask the host to send a fresh one');
  }
  const rtc = await loadRtc();
  const pc = connection(rtc, 'clausroom-guest', stun);
  const life = lifecycle(pc);
  const gathered = gather(pc);
  const authorized = deferred<void>();
  void authorized.promise.catch(() => undefined);
  let control: DataChannel | null = null;
  let nextTunnel = 1;
  let tunnels = 0;

  pc.onDataChannel((dc) => {
    if (control !== null || dc.getLabel() !== CONTROL || dc.getProtocol() !== CONTROL) {
      dc.close();
      return;
    }
    control = dc;
    dc.onMessage((raw) => {
      try {
        checkHello(raw, offer.session, 'host');
        authorized.resolve();
      } catch (err) {
        authorized.reject(err instanceof Error ? err : new Error(String(err)));
        pc.close();
      }
    });
    const greet = (): void => {
      if (!dc.sendMessage(hello(offer.session, 'join'))) {
        authorized.reject(new Error('could not greet the host'));
      }
    };
    if (dc.isOpen()) greet();
    else dc.onOpen(greet);
    dc.onError((why) => authorized.reject(new Error(`control channel failed: ${why}`)));
    dc.onClosed(() => authorized.reject(new Error('the host left before authenticating')));
  });

  const proxy = net.createServer((socket) => {
    if (tunnels >= MAX_TUNNELS || pc.state() !== 'connected') {
      socket.destroy();
      return;
    }
    tunnels += 1;
    let dc: DataChannel;
    try {
      dc = pc.createDataChannel(`${TUNNEL_LABEL}${nextTunnel++}`, { protocol: TUNNEL });
    } catch {
      tunnels -= 1;
      socket.destroy();
      return;
    }
    bind(dc, socket, () => {
      tunnels -= 1;
    });
  });
  proxy.on('error', (err) => {
    log(`local proxy error: ${err.message}`);
    pc.close();
  });

  const detach = onShutdown(() => {
    proxy.close();
    pc.close();
  });
  try {
    applySignal(pc, offer);
    pc.setLocalDescription('answer');
    const answer = await buildSignal(pc, gathered, 'answer', offer.session);
    emit('CLAUSROOM_PEER_ANSWER', encode(answer));
    log('send that answer back to the host; there is no deadline');

    // No timeout here on purpose: carrying the answer back is a human step, and
    // the host runs the bounded connectivity check once it arrives.
    await Promise.race([authorized.promise, life.failed.promise]);
    await life.connected.promise;
    reportPath(pc);

    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen({ host: '127.0.0.1', port: options.port }, resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('the local proxy did not bind');
    const url = `http://127.0.0.1:${address.port}`;
    // Ready means the room is usable, not merely that the socket is bound, so
    // the line comes after the session has been set up.
    await options.onReady({ url, invite: offer.room });
    emit('CLAUSROOM_PEER_READY', url);
    await Promise.race([life.closed.promise, life.failed.promise]);
  } finally {
    detach();
    proxy.close();
    pc.close();
    rtc.cleanup();
  }
}
