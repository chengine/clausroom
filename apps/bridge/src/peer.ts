/**
 * Manual-signaling WebRTC peer tunnel for Clausroom.
 *
 * The host does not open a conventional public TCP listener. It creates a
 * WebRTC offer and maps authenticated data channels to one fixed loopback-only
 * Clausroom server. The joining peer exposes a loopback-only TCP proxy so the
 * existing browser UI and bridge can continue to use ordinary HTTP/WebSocket.
 *
 * STUN is used only for address discovery. TURN URLs are deliberately rejected:
 * peer mode is direct-only and never sends room traffic through a relay.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stderr as promptOutput } from 'node:process';
import type {
  DataChannel,
  DescriptionType,
  PeerConnection,
  SelectedCandidateInfo,
} from 'node-datachannel';

const SIGNAL_VERSION = 1;
const OFFER_PREFIX = 'clausroom-offer-v1.';
const ANSWER_PREFIX = 'clausroom-answer-v1.';
const CONTROL_LABEL = 'clausroom-control-v1';
const CONTROL_PROTOCOL = 'clausroom-control-v1';
const TUNNEL_LABEL_PREFIX = 'clausroom-tcp-v1:';
const TUNNEL_PROTOCOL = 'clausroom-tcp-v1';
const DEFAULT_TARGET = 'http://127.0.0.1:3000';
const DEFAULT_STUN_URLS = [
  'stun:stun.cloudflare.com:3478',
  'stun:stun.l.google.com:19302',
];
const SIGNAL_MAX_BYTES = 512 * 1024;
const ICE_GATHER_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 45_000;
const DATA_CHUNK_BYTES = 16 * 1024;
const CHANNEL_BUFFER_HIGH = 1024 * 1024;
const CHANNEL_BUFFER_LOW = 256 * 1024;
const SOCKET_BUFFER_MAX = 8 * 1024 * 1024;
const MAX_TUNNELS = 128;

const FRAME_DATA = 1;
const FRAME_END = 2;
const FRAME_RESET = 3;

interface IceCandidate {
  candidate: string;
  mid: string;
}

interface PeerSignal {
  v: typeof SIGNAL_VERSION;
  kind: 'offer' | 'answer';
  session: string;
  sdp: string;
  candidates: IceCandidate[];
}

export interface PeerHostOptions {
  target?: string;
  stunUrls?: string[];
  answerFile?: string;
}

export interface PeerJoinOptions {
  offerFile?: string;
  listenPort?: number;
  stunUrls?: string[];
}

interface FixedTarget {
  host: '127.0.0.1' | '::1';
  port: number;
  display: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function log(line: string): void {
  process.stderr.write(`[clausroom-peer] ${line}\n`);
}

function machineLine(name: string, value: string): void {
  process.stdout.write(`${name} ${value}\n`);
}

function parseTarget(raw: string | undefined): FixedTarget {
  let url: URL;
  try {
    url = new URL(raw ?? DEFAULT_TARGET);
  } catch {
    throw new Error(`invalid --target URL: ${raw}`);
  }
  if (url.protocol !== 'http:') {
    throw new Error('--target must use http://; WebRTC already encrypts the peer hop');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) {
    throw new Error('--target must contain only a loopback host and port');
  }
  const host =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? '127.0.0.1'
      : url.hostname === '[::1]' || url.hostname === '::1'
        ? '::1'
        : null;
  if (host === null) {
    throw new Error('--target is restricted to 127.0.0.1, localhost, or ::1');
  }
  const port = Number(url.port || 80);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --target port: ${url.port}`);
  }
  return { host, port, display: `http://${host === '::1' ? '[::1]' : host}:${port}` };
}

function validateStunUrls(urls: string[] | undefined): string[] {
  const chosen = urls ?? DEFAULT_STUN_URLS;
  for (const value of chosen) {
    if (!value.startsWith('stun:') && !value.startsWith('stuns:')) {
      throw new Error(
        `peer mode accepts STUN discovery only; TURN relays are disabled (invalid: ${value})`,
      );
    }
  }
  return chosen;
}

function encodeSignal(signal: PeerSignal): string {
  const prefix = signal.kind === 'offer' ? OFFER_PREFIX : ANSWER_PREFIX;
  return prefix + Buffer.from(JSON.stringify(signal), 'utf8').toString('base64url');
}

function decodeSignal(raw: string, expectedKind: PeerSignal['kind']): PeerSignal {
  const text = raw.trim();
  if (text.length > SIGNAL_MAX_BYTES * 2) {
    throw new Error(`Clausroom ${expectedKind} code is too large`);
  }
  const prefix = expectedKind === 'offer' ? OFFER_PREFIX : ANSWER_PREFIX;
  if (!text.startsWith(prefix)) {
    throw new Error(`expected a Clausroom ${expectedKind} code beginning with ${prefix}`);
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(text.slice(prefix.length), 'base64url');
  } catch {
    throw new Error(`invalid Clausroom ${expectedKind} encoding`);
  }
  if (decoded.byteLength === 0 || decoded.byteLength > SIGNAL_MAX_BYTES) {
    throw new Error(`invalid Clausroom ${expectedKind} size`);
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error(`invalid Clausroom ${expectedKind} JSON`);
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as Partial<PeerSignal>).v !== SIGNAL_VERSION ||
    (value as Partial<PeerSignal>).kind !== expectedKind ||
    typeof (value as Partial<PeerSignal>).session !== 'string' ||
    !/^[A-Za-z0-9_-]{16,64}$/.test((value as Partial<PeerSignal>).session ?? '') ||
    typeof (value as Partial<PeerSignal>).sdp !== 'string' ||
    !(value as Partial<PeerSignal>).sdp?.includes('a=fingerprint:') ||
    !Array.isArray((value as Partial<PeerSignal>).candidates)
  ) {
    throw new Error(`malformed Clausroom ${expectedKind}`);
  }
  const signal = value as PeerSignal;
  if (
    signal.sdp.length > SIGNAL_MAX_BYTES ||
    signal.candidates.length > 256 ||
    signal.candidates.some(
      (candidate) =>
        typeof candidate !== 'object' ||
        candidate === null ||
        typeof candidate.candidate !== 'string' ||
        typeof candidate.mid !== 'string' ||
        candidate.candidate.length > 4096 ||
        candidate.mid.length > 64,
    )
  ) {
    throw new Error(`malformed Clausroom ${expectedKind} candidates`);
  }
  return signal;
}

async function readSignalFileOrPrompt(
  file: string | undefined,
  label: 'offer' | 'answer',
): Promise<string> {
  if (file) {
    const absolute = path.resolve(file);
    const stat = await fs.stat(absolute);
    if (stat.size > SIGNAL_MAX_BYTES * 2) {
      throw new Error(`Clausroom ${label} file is too large`);
    }
    return fs.readFile(absolute, 'utf8');
  }
  const rl = readline.createInterface({ input, output: promptOutput });
  try {
    return await rl.question(`Paste the Clausroom ${label} code, then press Enter:\n> `);
  } finally {
    rl.close();
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function createSignalCollector(pc: PeerConnection): {
  candidates: IceCandidate[];
  description: Deferred<{ sdp: string; type: DescriptionType }>;
  complete: Deferred<void>;
} {
  const candidates: IceCandidate[] = [];
  const description = deferred<{ sdp: string; type: DescriptionType }>();
  const complete = deferred<void>();
  pc.onLocalDescription((sdp, type) => description.resolve({ sdp, type }));
  pc.onLocalCandidate((candidate, mid) => candidates.push({ candidate, mid }));
  pc.onGatheringStateChange((state) => {
    if (state === 'complete') complete.resolve();
  });
  return { candidates, description, complete };
}

async function collectSignal(
  pc: PeerConnection,
  collector: ReturnType<typeof createSignalCollector>,
  kind: PeerSignal['kind'],
  session: string,
): Promise<PeerSignal> {
  const [{ sdp, type }] = await Promise.all([
    withTimeout(collector.description.promise, ICE_GATHER_TIMEOUT_MS, 'local description'),
    withTimeout(collector.complete.promise, ICE_GATHER_TIMEOUT_MS, 'ICE gathering'),
  ]);
  if (type !== kind) {
    throw new Error(`WebRTC created ${type}, expected ${kind}`);
  }
  const current = pc.localDescription();
  return {
    v: SIGNAL_VERSION,
    kind,
    session,
    sdp: current?.sdp ?? sdp,
    candidates: collector.candidates,
  };
}

function applyRemoteSignal(pc: PeerConnection, signal: PeerSignal): void {
  pc.setRemoteDescription(signal.sdp, signal.kind);
  for (const { candidate, mid } of signal.candidates) {
    pc.addRemoteCandidate(candidate, mid);
  }
}

function toBuffer(message: string | Buffer | ArrayBuffer): Buffer | null {
  if (typeof message === 'string') return null;
  return Buffer.isBuffer(message) ? message : Buffer.from(message);
}

function makeFrame(type: number, payload?: Buffer): Buffer {
  if (!payload || payload.byteLength === 0) {
    return Buffer.from([type]);
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 1);
  frame[0] = type;
  payload.copy(frame, 1);
  return frame;
}

/**
 * Bind one reliable ordered DataChannel to one TCP socket. A one-byte frame
 * preserves half-close semantics; data is never interpreted as a path or
 * command by the tunnel.
 */
function bindChannelToSocket(
  dc: DataChannel,
  socket: net.Socket,
  onDone: () => void,
): void {
  let channelOpen = dc.isOpen();
  let localEnded = false;
  let remoteEnded = false;
  let done = false;
  let outgoingBytes = 0;
  let retryTimer: NodeJS.Timeout | undefined;
  const outgoing: Buffer[] = [];

  const channelIsOpen = (): boolean => {
    try {
      return dc.isOpen();
    } catch {
      return false;
    }
  };

  const bufferedAmount = (): number => {
    try {
      return dc.bufferedAmount();
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  };

  const finish = (reset: boolean): void => {
    if (done) return;
    done = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      if (reset && channelIsOpen()) dc.sendMessageBinary(makeFrame(FRAME_RESET));
    } catch {
      /* the peer may have destroyed the native channel concurrently */
    }
    socket.destroy();
    try {
      dc.close();
    } catch {
      /* already closed */
    }
    onDone();
  };

  const updateSocketFlow = (): void => {
    if (
      !done &&
      channelOpen &&
      outgoingBytes < CHANNEL_BUFFER_HIGH &&
      bufferedAmount() < CHANNEL_BUFFER_HIGH
    ) {
      socket.resume();
    }
    else socket.pause();
  };

  const scheduleRetry = (): void => {
    if (retryTimer || done) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      pump();
    }, 10);
    retryTimer.unref();
  };

  const maybeFinish = (): void => {
    if (!localEnded || !remoteEnded || outgoing.length > 0 || done) return;
    if (bufferedAmount() > 0) {
      scheduleRetry();
      return;
    }
    finish(false);
  };

  const pump = (): void => {
    if (done || !channelOpen) {
      updateSocketFlow();
      return;
    }
    while (outgoing.length > 0 && bufferedAmount() < CHANNEL_BUFFER_HIGH) {
      const frame = outgoing[0];
      if (!frame) break;
      let sent = false;
      try {
        sent = dc.sendMessageBinary(frame);
      } catch {
        finish(false);
        return;
      }
      if (!sent) {
        scheduleRetry();
        break;
      }
      outgoing.shift();
      outgoingBytes -= frame.byteLength;
    }
    updateSocketFlow();
    maybeFinish();
  };

  const enqueue = (type: number, payload?: Buffer): boolean => {
    if (done) return false;
    const frame = makeFrame(type, payload);
    if (outgoingBytes + frame.byteLength > SOCKET_BUFFER_MAX) {
      log('closing a tunnel whose WebRTC send queue exceeded the memory limit');
      finish(true);
      return false;
    }
    outgoing.push(frame);
    outgoingBytes += frame.byteLength;
    pump();
    return !done;
  };

  socket.pause();
  dc.setBufferedAmountLowThreshold(CHANNEL_BUFFER_LOW);
  dc.onOpen(() => {
    channelOpen = true;
    pump();
  });
  dc.onBufferedAmountLow(pump);
  dc.onError((message) => {
    log(`data channel error: ${message}`);
    finish(false);
  });
  dc.onClosed(() => {
    if (!done) {
      done = true;
      socket.destroy();
      onDone();
    }
  });
  dc.onMessage((message) => {
    const frame = toBuffer(message);
    if (!frame || frame.byteLength < 1) {
      finish(true);
      return;
    }
    switch (frame[0]) {
      case FRAME_DATA: {
        if (
          remoteEnded ||
          frame.byteLength === 1 ||
          frame.byteLength > DATA_CHUNK_BYTES + 1
        ) {
          finish(true);
          return;
        }
        socket.write(frame.subarray(1));
        if (socket.writableLength > SOCKET_BUFFER_MAX) {
          log('closing a tunnel whose TCP receiver exceeded the memory limit');
          finish(true);
        }
        break;
      }
      case FRAME_END:
        if (frame.byteLength !== 1 || remoteEnded) {
          finish(true);
          return;
        }
        remoteEnded = true;
        socket.end();
        maybeFinish();
        break;
      case FRAME_RESET:
        finish(false);
        break;
      default:
        finish(true);
    }
  });

  socket.on('data', (chunk: Buffer) => {
    for (let offset = 0; offset < chunk.byteLength; offset += DATA_CHUNK_BYTES) {
      if (!enqueue(FRAME_DATA, chunk.subarray(offset, offset + DATA_CHUNK_BYTES))) return;
    }
  });
  socket.on('end', () => {
    localEnded = true;
    enqueue(FRAME_END);
    maybeFinish();
  });
  socket.on('error', (err) => {
    log(`TCP tunnel error: ${err.message}`);
    finish(true);
  });
  socket.on('close', (hadError) => {
    if (!done && hadError) finish(true);
    else if (!done && !localEnded && !remoteEnded) finish(true);
    else maybeFinish();
  });

  pump();
}

function configurePeerLifecycle(pc: PeerConnection): {
  connected: Deferred<void>;
  closed: Deferred<void>;
  failed: Deferred<never>;
} {
  const connected = deferred<void>();
  const closed = deferred<void>();
  const failed = deferred<never>();
  // ICE may fail while a human is still copying signaling text. Mark the
  // promise handled immediately; callers still await the original below.
  void failed.promise.catch(() => undefined);
  pc.onStateChange((state) => {
    log(`connection state: ${state}`);
    if (state === 'connected') connected.resolve();
    else if (state === 'closed') closed.resolve();
    else if (state === 'failed') failed.reject(new Error('WebRTC direct connection failed'));
  });
  return { connected, closed, failed };
}

function describeCandidate(candidate: SelectedCandidateInfo): string {
  return `${candidate.type}/${candidate.transportType} ${candidate.address}:${candidate.port}`;
}

function reportDirectPath(pc: PeerConnection): void {
  const pair = pc.getSelectedCandidatePair();
  if (!pair) {
    log('connected directly (candidate details unavailable)');
    machineLine('CLAUSROOM_PEER_PATH', 'direct');
    return;
  }
  if (pair.local.type === 'relay' || pair.remote.type === 'relay') {
    pc.close();
    throw new Error('refusing relayed candidate pair in direct-only peer mode');
  }
  const summary = `${describeCandidate(pair.local)} -> ${describeCandidate(pair.remote)}`;
  log(`selected direct ICE path: ${summary}`);
  machineLine('CLAUSROOM_PEER_PATH', `direct ${summary}`);
}

function installShutdown(pc: PeerConnection, closeExtra?: () => void): () => void {
  const stop = (): void => {
    try {
      closeExtra?.();
    } catch {
      /* shutdown is best-effort */
    }
    try {
      pc.close();
    } catch {
      /* already closed */
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return () => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  };
}

function waitForControlOpen(dc: DataChannel): Promise<void> {
  if (dc.isOpen()) return Promise.resolve();
  const opened = deferred<void>();
  dc.onOpen(opened.resolve);
  dc.onError((message) => opened.reject(new Error(`control data channel failed: ${message}`)));
  dc.onClosed(() => opened.reject(new Error('control data channel closed before authentication')));
  return opened.promise;
}

async function loadRtc(): Promise<typeof import('node-datachannel').default> {
  try {
    return (await import('node-datachannel')).default;
  } catch (err) {
    if (
      err instanceof Error &&
      ('code' in err ? (err as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' : false)
    ) {
      throw new Error(
        'peer mode needs the optional node-datachannel package; reinstall clausroom-bridge with optional dependencies enabled',
      );
    }
    throw err;
  }
}

export async function runPeerHost(options: PeerHostOptions): Promise<void> {
  const target = parseTarget(options.target);
  const stunUrls = validateStunUrls(options.stunUrls);
  const rtc = await loadRtc();
  const session = randomBytes(18).toString('base64url');
  const pc = new rtc.PeerConnection('clausroom-host', {
    iceServers: stunUrls,
    disableAutoNegotiation: true,
    maxMessageSize: 256 * 1024,
  });
  const lifecycle = configurePeerLifecycle(pc);
  const signalCollector = createSignalCollector(pc);
  let authenticated = false;
  let activeTunnels = 0;

  const control = pc.createDataChannel(CONTROL_LABEL, { protocol: CONTROL_PROTOCOL });
  const authorized = deferred<void>();
  void authorized.promise.catch(() => undefined);
  control.onMessage((message) => {
    if (typeof message !== 'string' || authenticated) return;
    try {
      if (message.length > 1024) throw new Error('peer hello is too large');
      const hello = JSON.parse(message) as { v?: unknown; session?: unknown; role?: unknown };
      if (hello.v !== SIGNAL_VERSION || hello.session !== session || hello.role !== 'join') {
        throw new Error('peer session mismatch');
      }
      authenticated = true;
      if (!control.sendMessage(JSON.stringify({ v: SIGNAL_VERSION, session, role: 'host' }))) {
        throw new Error('could not acknowledge peer');
      }
      authorized.resolve();
    } catch (err) {
      authorized.reject(err instanceof Error ? err : new Error(String(err)));
      pc.close();
    }
  });
  control.onError((message) => authorized.reject(new Error(`control channel failed: ${message}`)));
  control.onClosed(() => {
    if (!authenticated) authorized.reject(new Error('control channel closed before authentication'));
  });

  pc.onDataChannel((dc) => {
    if (
      !authenticated ||
      dc.getProtocol() !== TUNNEL_PROTOCOL ||
      !dc.getLabel().startsWith(TUNNEL_LABEL_PREFIX) ||
      activeTunnels >= MAX_TUNNELS
    ) {
      dc.close();
      return;
    }
    activeTunnels += 1;
    const socket = net.createConnection({ host: target.host, port: target.port });
    bindChannelToSocket(dc, socket, () => {
      activeTunnels -= 1;
    });
  });

  const uninstallShutdown = installShutdown(pc);
  try {
    pc.setLocalDescription('offer');
    const offer = await collectSignal(pc, signalCollector, 'offer', session);
    log(`fixed host target: ${target.display} (loopback only)`);
    log(
      stunUrls.length === 0
        ? 'STUN disabled; only directly discoverable addresses will be tried'
        : `STUN discovery: ${stunUrls.join(', ')}`,
    );
    machineLine('CLAUSROOM_PEER_OFFER', encodeSignal(offer));
    log('send the offer code privately to the other participant');

    const rawAnswer = await readSignalFileOrPrompt(options.answerFile, 'answer');
    const answer = decodeSignal(rawAnswer, 'answer');
    if (answer.session !== session) throw new Error('answer belongs to a different peer session');
    applyRemoteSignal(pc, answer);

    await withTimeout(
      Promise.race([authorized.promise, lifecycle.failed.promise]),
      CONNECT_TIMEOUT_MS,
      'direct peer authentication',
    );
    await lifecycle.connected.promise;
    reportDirectPath(pc);
    machineLine('CLAUSROOM_PEER_READY', target.display);
    log('peer authorized; forwarding only to the fixed Clausroom loopback target');
    await Promise.race([lifecycle.closed.promise, lifecycle.failed.promise]);
  } finally {
    uninstallShutdown();
    pc.close();
    rtc.cleanup();
  }
}

export async function runPeerJoin(options: PeerJoinOptions): Promise<void> {
  const port = options.listenPort ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--listen-port must be an integer from 0 to 65535');
  }
  const stunUrls = validateStunUrls(options.stunUrls);
  const rawOffer = await readSignalFileOrPrompt(options.offerFile, 'offer');
  const offer = decodeSignal(rawOffer, 'offer');
  const rtc = await loadRtc();
  const pc = new rtc.PeerConnection('clausroom-join', {
    iceServers: stunUrls,
    disableAutoNegotiation: true,
    maxMessageSize: 256 * 1024,
  });
  const lifecycle = configurePeerLifecycle(pc);
  const signalCollector = createSignalCollector(pc);
  const authorized = deferred<void>();
  void authorized.promise.catch(() => undefined);
  let control: DataChannel | null = null;
  let nextTunnel = 1;
  let activeTunnels = 0;

  pc.onDataChannel((dc) => {
    if (
      control !== null ||
      dc.getLabel() !== CONTROL_LABEL ||
      dc.getProtocol() !== CONTROL_PROTOCOL
    ) {
      dc.close();
      return;
    }
    control = dc;
    dc.onMessage((message) => {
      if (typeof message !== 'string') return;
      try {
        if (message.length > 1024) throw new Error('peer hello is too large');
        const hello = JSON.parse(message) as { v?: unknown; session?: unknown; role?: unknown };
        if (
          hello.v !== SIGNAL_VERSION ||
          hello.session !== offer.session ||
          hello.role !== 'host'
        ) {
          throw new Error('host session mismatch');
        }
        authorized.resolve();
      } catch (err) {
        authorized.reject(err instanceof Error ? err : new Error(String(err)));
        pc.close();
      }
    });
    void waitForControlOpen(dc)
      .then(() => {
        if (
          !dc.sendMessage(
            JSON.stringify({ v: SIGNAL_VERSION, session: offer.session, role: 'join' }),
          )
        ) {
          throw new Error('could not authenticate to host');
        }
      })
      .catch(authorized.reject);
  });

  const proxy = net.createServer((socket) => {
    if (activeTunnels >= MAX_TUNNELS || pc.state() !== 'connected') {
      socket.destroy();
      return;
    }
    activeTunnels += 1;
    let dc: DataChannel;
    try {
      dc = pc.createDataChannel(`${TUNNEL_LABEL_PREFIX}${nextTunnel++}`, {
        protocol: TUNNEL_PROTOCOL,
      });
    } catch {
      activeTunnels -= 1;
      socket.destroy();
      return;
    }
    bindChannelToSocket(dc, socket, () => {
      activeTunnels -= 1;
    });
  });
  proxy.on('error', (err) => {
    log(`local proxy error: ${err.message}`);
    pc.close();
  });

  const uninstallShutdown = installShutdown(pc, () => proxy.close());
  try {
    applyRemoteSignal(pc, offer);
    pc.setLocalDescription('answer');
    const answer = await collectSignal(pc, signalCollector, 'answer', offer.session);
    machineLine('CLAUSROOM_PEER_ANSWER', encodeSignal(answer));
    log('send the answer code privately to the host; waiting for the direct path');

    await withTimeout(
      Promise.race([authorized.promise, lifecycle.failed.promise]),
      CONNECT_TIMEOUT_MS,
      'direct peer authentication',
    );
    await lifecycle.connected.promise;
    reportDirectPath(pc);

    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen({ host: '127.0.0.1', port }, resolve);
    });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('local proxy did not bind a TCP port');
    const localUrl = `http://127.0.0.1:${address.port}`;
    machineLine('CLAUSROOM_PEER_READY', localUrl);
    log(`local-only Clausroom URL: ${localUrl}`);
    log('leave this command running while the room is in use');

    await Promise.race([lifecycle.closed.promise, lifecycle.failed.promise]);
  } finally {
    uninstallShutdown();
    proxy.close();
    pc.close();
    rtc.cleanup();
  }
}
