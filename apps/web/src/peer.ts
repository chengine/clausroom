/** Browser-owned WebRTC, adapted from the proven Crazy Camels manual flow. */
import {
  PEER,
  PeerBootstrapSchema,
  PeerRoomInviteSchema,
  type PeerBootstrap,
  type PeerRoomInvite,
} from '@clausroom/protocol';
import { trace } from './trace.js';

const OFFER = 'CLAUSROOM-OFFER-2.';
const ANSWER = 'CLAUSROOM-ANSWER-2.';
const HEARTBEAT_MS = 5_000;
const CLOSE_MS = 5_000;
type Progress = (message: string) => void;

interface Signal {
  v: typeof PEER.VERSION;
  kind: 'offer' | 'answer';
  session: string;
  sdp: string;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

async function transform(bytes: Uint8Array, stream: GenericTransformStream): Promise<Uint8Array> {
  const source = new Blob([bytes as BlobPart]).stream();
  const reader = source
    .pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
    .getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > PEER.SIGNAL_BYTES) {
      await reader.cancel();
      throw new Error('signal expands beyond its size limit');
    }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** The fragment owns this page for the CLI session and reconstructs it on reload. */
export function readPeerBootstrap(): PeerBootstrap | 'invalid' | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!params.has('clausroom-peer')) return null;
  try {
    const raw = dec.decode(fromBase64(params.get('clausroom-peer') ?? ''));
    const parsed = PeerBootstrapSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : 'invalid';
  } catch {
    return 'invalid';
  }
}

function sessionId(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(18)));
}

async function encodeSignal(signal: Signal): Promise<string> {
  const raw = enc.encode(JSON.stringify(signal));
  let body: Uint8Array = raw;
  let flag = 'r';
  if (typeof CompressionStream === 'function') {
    try {
      body = await transform(body, new CompressionStream('deflate-raw'));
      flag = 'z';
    } catch {
      body = raw;
    }
  }
  const code = (signal.kind === 'offer' ? OFFER : ANSWER) + flag + toBase64(body);
  trace('signal', `${signal.kind} encoded`, { characters: code.length });
  return code;
}

async function decodeSignal(input: string, kind: Signal['kind']): Promise<Signal> {
  const prefix = kind === 'offer' ? OFFER : ANSWER;
  const label = kind === 'offer' ? 'CLAUSROOM_PEER_OFFER ' : 'CLAUSROOM_PEER_ANSWER ';
  const compact = input.trim().replace(new RegExp(`^${label}`, 'i'), '').replace(/\s+/g, '');
  if (!compact.toUpperCase().startsWith(prefix)) throw new Error(`That is not a Clausroom ${kind}.`);
  if (compact.length > PEER.SIGNAL_BYTES) throw new Error(`That ${kind} is too long.`);
  try {
    const flag = compact[prefix.length];
    let body = fromBase64(compact.slice(prefix.length + 1));
    if (flag === 'z') body = await transform(body, new DecompressionStream('deflate-raw'));
    else if (flag !== 'r') throw new Error();
    const value = JSON.parse(dec.decode(body)) as Partial<Signal>;
    if (
      value.v !== PEER.VERSION ||
      value.kind !== kind ||
      typeof value.session !== 'string' ||
      !/^[A-Za-z0-9_-]{16,64}$/.test(value.session) ||
      typeof value.sdp !== 'string' ||
      value.sdp.length > PEER.SIGNAL_BYTES ||
      !value.sdp.includes('a=fingerprint:')
    ) {
      throw new Error();
    }
    trace('signal', `${kind} accepted`, { characters: compact.length });
    return value as Signal;
  } catch {
    throw new Error(`That ${kind} is damaged. Copy the whole code and try again.`);
  }
}

function connection(stun: string[], side: 'host' | 'guest'): RTCPeerConnection {
  const pc = new RTCPeerConnection({
    iceServers: stun.length ? [{ urls: stun }] : [],
    iceCandidatePoolSize: 2,
  });
  trace('peer', `${side}: created`, { stunServers: stun.length });
  for (const [event, state] of [
    ['signalingstatechange', () => pc.signalingState],
    ['icegatheringstatechange', () => pc.iceGatheringState],
    ['iceconnectionstatechange', () => pc.iceConnectionState],
    ['connectionstatechange', () => pc.connectionState],
  ] as const) pc.addEventListener(event, () => trace('peer', `${side}: ${event}`, state()));
  pc.addEventListener('icecandidateerror', (event) => {
    const error = event as RTCPeerConnectionIceErrorEvent;
    trace('peer', `${side}: ICE candidate error`, { code: error.errorCode, text: error.errorText });
  });
  return pc;
}

/** Resolve only when the browser has finished gathering every candidate. */
function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState !== 'complete') return;
      pc.removeEventListener('icegatheringstatechange', check);
      const lines = pc.localDescription?.sdp.match(/^a=candidate:.*$/gm) ?? [];
      trace('peer', 'gathering complete', {
        host: lines.filter((line) => / typ host/.test(line)).length,
        public: lines.filter((line) => / typ (srflx|prflx|relay)/.test(line)).length,
      });
      resolve();
    };
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function heartbeat(pc: RTCPeerConnection, progress: Progress): () => void {
  const started = Date.now();
  const timer = setInterval(
    () => progress(`Still connecting — ${Math.round((Date.now() - started) / 1000)}s (${pc.iceConnectionState}).`),
    HEARTBEAT_MS,
  );
  trace('peer', 'waiting for the other browser');
  return () => clearInterval(timer);
}

function opened(pc: RTCPeerConnection, channel: RTCDataChannel, progress: Progress): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const stop = heartbeat(pc, progress);
    const finish = (error?: Error) => {
      stop();
      channel.removeEventListener('open', ok);
      channel.removeEventListener('error', fail);
      channel.removeEventListener('close', fail);
      pc.removeEventListener('connectionstatechange', state);
      if (error) reject(error);
      else resolve();
    };
    const ok = () => finish();
    const fail = () => finish(new Error('The peer connection failed.'));
    const state = () => {
      if (pc.connectionState === 'failed') {
        finish(new Error('ICE found no usable direct path. Check the VPN or firewall and try again.'));
      } else if (pc.connectionState === 'closed') fail();
    };
    channel.addEventListener('open', ok);
    channel.addEventListener('error', fail);
    channel.addEventListener('close', fail);
    pc.addEventListener('connectionstatechange', state);
    if (channel.readyState === 'closed') return fail();
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      return state();
    }
  });
}

interface CandidateReport {
  id: string;
  type: string;
  state?: string;
  nominated?: boolean;
  selected?: boolean;
  selectedCandidatePairId?: string;
  localCandidateId?: string;
  remoteCandidateId?: string;
  candidateType?: string;
  protocol?: string;
  address?: string;
  ip?: string;
  port?: number;
}

/** Fail closed unless browser stats prove the selected pair is direct. */
async function directPath(pc: RTCPeerConnection): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const stats = await pc.getStats();
    const all = new Map<string, CandidateReport>();
    stats.forEach((report) => all.set(report.id, report as unknown as CandidateReport));
    const transport = [...all.values()].find((report) => report.type === 'transport');
    const pair =
      (transport?.selectedCandidatePairId ? all.get(transport.selectedCandidatePairId) : undefined) ??
      [...all.values()].find(
        (report) =>
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          (report.selected || report.nominated),
      );
    const local = pair?.localCandidateId ? all.get(pair.localCandidateId) : undefined;
    const remote = pair?.remoteCandidateId ? all.get(pair.remoteCandidateId) : undefined;
    if (local?.candidateType && remote?.candidateType) {
      if (local.candidateType === 'relay' || remote.candidateType === 'relay') {
        throw new Error('Refusing a relayed ICE path.');
      }
      const show = (candidate: CandidateReport) =>
        `${candidate.candidateType}/${candidate.protocol ?? '?'} ${candidate.address ?? candidate.ip ?? '?'}:${candidate.port ?? '?'}`;
      const path = `${show(local)} → ${show(remote)}`;
      trace('peer', 'direct path selected', {
        local: `${local.candidateType}/${local.protocol ?? '?'}`,
        remote: `${remote.candidateType}/${remote.protocol ?? '?'}`,
      });
      return path;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('The browser could not prove that the selected ICE path is direct.');
}

function tunnelUrl(secret: string, id?: string): string {
  const url = new URL(`${PEER.PATH}/tunnel`, location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('secret', secret);
  if (id) url.searchParams.set('id', id);
  return url.toString();
}

/** Bounded, binary-only bridge. A failure closes this tunnel, not the room. */
function bridge(channel: RTCDataChannel, socket: WebSocket): void {
  channel.binaryType = 'arraybuffer';
  socket.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = PEER.BUFFER_LOW;
  const toChannel: ArrayBuffer[] = [];
  const toSocket: ArrayBuffer[] = [];
  let channelBytes = 0;
  let socketBytes = 0;
  let done = false;
  let channelEnded = false;
  let socketEnded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = () => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (closeTimer) clearTimeout(closeTimer);
    try {
      channel.close();
    } catch {
      /* closed */
    }
    try {
      socket.close();
    } catch {
      /* closed */
    }
  };
  const later = () => {
    if (!timer && !done) {
      timer = setTimeout(() => {
        timer = undefined;
        pump();
      }, 10);
    }
  };
  const pump = () => {
    if (done) return;
    try {
      while (
        channel.readyState === 'open' &&
        channel.bufferedAmount < PEER.BUFFER_HIGH &&
        toChannel.length
      ) {
        const next = toChannel.shift();
        if (!next) break;
        channelBytes -= next.byteLength;
        channel.send(next);
      }
      while (
        socket.readyState === WebSocket.OPEN &&
        socket.bufferedAmount < PEER.BUFFER_HIGH &&
        toSocket.length
      ) {
        const next = toSocket.shift();
        if (!next) break;
        socketBytes -= next.byteLength;
        socket.send(next);
      }
      if (
        socketEnded &&
        !toChannel.length &&
        channel.bufferedAmount === 0 &&
        channel.readyState !== 'closed'
      ) {
        channel.close();
      }
      if (
        channelEnded &&
        !toSocket.length &&
        socket.bufferedAmount === 0 &&
        socket.readyState !== WebSocket.CLOSED
      ) {
        socket.close();
      }
      if (socketEnded && channelEnded && !toChannel.length && !toSocket.length) {
        done = true;
        if (timer) clearTimeout(timer);
        if (closeTimer) clearTimeout(closeTimer);
        timer = undefined;
        closeTimer = undefined;
        return;
      }
    } catch {
      return abort();
    }
    if (toChannel.length || toSocket.length || socketEnded || channelEnded) later();
  };
  const enqueue = (queue: ArrayBuffer[], data: unknown, towardChannel: boolean) => {
    if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > PEER.CHUNK_BYTES) {
      return abort();
    }
    if (towardChannel) channelBytes += data.byteLength;
    else socketBytes += data.byteLength;
    if (channelBytes > PEER.QUEUE_BYTES || socketBytes > PEER.QUEUE_BYTES) return abort();
    queue.push(data);
    pump();
  };

  socket.onmessage = (event) => enqueue(toChannel, event.data, true);
  channel.onmessage = (event) => enqueue(toSocket, event.data, false);
  socket.onopen = pump;
  channel.onopen = pump;
  channel.onbufferedamountlow = pump;
  socket.onerror = abort;
  channel.onerror = abort;
  socket.onclose = () => {
    socketEnded = true;
    closeTimer ??= setTimeout(abort, CLOSE_MS);
    pump();
  };
  channel.onclose = () => {
    channelEnded = true;
    closeTimer ??= setTimeout(abort, CLOSE_MS);
    pump();
  };
}

export interface HostPeer {
  readonly code: string;
  accept(answer: string): Promise<string>;
  close(): void;
}

export async function hostPeer(
  bootstrap: Extract<PeerBootstrap, { role: 'host' }>,
  lost: (message: string) => void,
  progress: Progress,
): Promise<HostPeer> {
  const pc = connection(bootstrap.stun, 'host');
  const session = sessionId();
  const control = pc.createDataChannel(PEER.CONTROL_CHANNEL, { ordered: true });
  const tunnels = new Set<RTCDataChannel>();
  let authorized = false;
  let applied = false;
  let ending = false;
  let welcomed = false;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => undefined);
  const failed = (message: string) => {
    if (ending) return;
    ending = true;
    authorized = false;
    readyReject(new Error(message));
    lost(message);
  };
  const shutdown = () => {
    ending = true;
    authorized = false;
    readyReject(new Error('The peer connection was closed.'));
    for (const tunnel of tunnels) tunnel.close();
    control.close();
    pc.close();
  };

  pc.ondatachannel = ({ channel }) => {
    const id = channel.label.slice(PEER.TUNNEL_CHANNEL_PREFIX.length);
    if (
      !authorized ||
      !channel.label.startsWith(PEER.TUNNEL_CHANNEL_PREFIX) ||
      !/^[0-9a-f]{24}$/.test(id) ||
      tunnels.size >= PEER.MAX_TUNNELS
    ) {
      channel.close();
      return;
    }
    tunnels.add(channel);
    channel.addEventListener('close', () => tunnels.delete(channel));
    bridge(channel, new WebSocket(tunnelUrl(bootstrap.secret)));
  };
  control.onmessage = (event) => {
    try {
      if (typeof event.data !== 'string' || event.data.length > 1024) throw new Error();
      const message = JSON.parse(event.data) as {
        type?: unknown;
        session?: unknown;
        message?: unknown;
      };
      if (!welcomed || message.session !== session) throw new Error();
      if (message.type === 'ready') readyResolve();
      else if (message.type === 'error' && typeof message.message === 'string') {
        readyReject(new Error(`The guest connector failed: ${message.message.slice(0, 300)}`));
      } else throw new Error();
    } catch {
      readyReject(new Error('The guest sent an invalid readiness response.'));
    }
  };
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed') {
      failed('The direct connection was lost. Create a fresh invite to reconnect.');
    }
  });
  control.addEventListener('close', () =>
    failed('The direct connection closed. Create a fresh invite to reconnect.'),
  );
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  const code = await encodeSignal({
    v: PEER.VERSION,
    kind: 'offer',
    session,
    sdp: pc.localDescription?.sdp ?? '',
  });

  return {
    code,
    async accept(raw) {
      const answer = await decodeSignal(raw, 'answer');
      if (answer.session !== session) throw new Error('That answer belongs to another invite.');
      if (applied) throw new Error('That answer was already applied.');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      trace('peer', 'host: answer applied');
      applied = true;
      await opened(pc, control, progress);
      const path = await directPath(pc);
      authorized = true;
      welcomed = true;
      control.send(JSON.stringify({ type: 'welcome', session, room: bootstrap.room }));
      try {
        await ready;
      } catch (error) {
        shutdown();
        throw error;
      }
      return path;
    },
    close() {
      shutdown();
    },
  };
}

export interface GuestPeer {
  readonly code: string;
  readonly connected: Promise<string>;
  openTunnel(id: string): void;
  confirm(error?: string): boolean;
  close(): void;
}

export async function guestPeer(
  offerCode: string,
  bootstrap: Extract<PeerBootstrap, { role: 'guest' }>,
  welcome: (room: PeerRoomInvite) => void,
  lost: (message: string) => void,
  progress: Progress,
): Promise<GuestPeer> {
  const offer = await decodeSignal(offerCode, 'offer');
  const pc = connection(bootstrap.stun, 'guest');
  const tunnels = new Set<RTCDataChannel>();
  const tunnelIds = new Set<string>();
  let control: RTCDataChannel | null = null;
  let prove: Promise<string> | null = null;
  let ending = false;
  const failed = (message: string) => {
    if (ending) return;
    ending = true;
    lost(message);
  };

  pc.ondatachannel = ({ channel }) => {
    if (channel.label !== PEER.CONTROL_CHANNEL || control) return channel.close();
    control = channel;
    prove = opened(pc, channel, progress).then(() => directPath(pc));
    channel.addEventListener('close', () =>
      failed('The direct connection closed. Ask the host for a fresh invite.'),
    );
    channel.onmessage = (event) => {
      void (async () => {
        try {
          const direct = prove;
          if (!direct) throw new Error();
          await direct;
          const value = JSON.parse(String(event.data)) as {
            type?: unknown;
            session?: unknown;
            room?: unknown;
          };
          const room = PeerRoomInviteSchema.safeParse(value.room);
          if (value.type !== 'welcome' || value.session !== offer.session || !room.success) {
            throw new Error();
          }
          welcome(room.data);
        } catch {
          failed('The host sent an invalid room handshake.');
          pc.close();
        }
      })();
    };
  };
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' && control?.readyState === 'open') {
      failed('The direct connection was lost. Ask the host for a fresh invite.');
    }
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  const code = await encodeSignal({
    v: PEER.VERSION,
    kind: 'answer',
    session: offer.session,
    sdp: pc.localDescription?.sdp ?? '',
  });
  const connected = new Promise<string>((resolve, reject) => {
    const stop = heartbeat(pc, progress);
    const wait = () => {
      if (prove) {
        stop();
        void prove.then(resolve, reject);
      }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        stop();
        reject(new Error('The answer expired before the host used it.'));
      }
      else setTimeout(wait, 25);
    };
    wait();
  });

  return {
    code,
    connected,
    confirm(error) {
      if (control?.readyState !== 'open') return false;
      try {
        control.send(
          JSON.stringify(
            error
              ? { type: 'error', session: offer.session, message: error.slice(0, 300) }
              : { type: 'ready', session: offer.session },
          ),
        );
        return true;
      } catch {
        failed('The readiness response could not be sent. Ask the host for a fresh invite.');
        return false;
      }
    },
    openTunnel(id) {
      if (
        !/^[0-9a-f]{24}$/.test(id) ||
        !prove ||
        ending ||
        tunnelIds.has(id) ||
        tunnelIds.size >= PEER.MAX_TUNNELS
      ) return;
      tunnelIds.add(id);
      void (async () => {
        let channel: RTCDataChannel | undefined;
        try {
          await prove;
          if (ending) {
            tunnelIds.delete(id);
            return;
          }
          const created = pc.createDataChannel(`${PEER.TUNNEL_CHANNEL_PREFIX}${id}`, { ordered: true });
          channel = created;
          tunnels.add(created);
          created.addEventListener('close', () => {
            tunnels.delete(created);
            tunnelIds.delete(id);
          });
          bridge(created, new WebSocket(tunnelUrl(bootstrap.secret, id)));
        } catch {
          channel?.close();
          tunnelIds.delete(id);
          /* the room-level reconnect path reports peer failure */
        }
      })();
    },
    close() {
      ending = true;
      for (const tunnel of tunnels) tunnel.close();
      control?.close();
      pc.close();
    },
  };
}
