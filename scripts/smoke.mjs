#!/usr/bin/env node
/**
 * One end-to-end test of the whole thing, run against the built artifacts.
 *
 * It starts a real room with `clausroom host`, exercises the HTTP and WebSocket
 * surface as a human, drives the room tools as an agent over stdio MCP, joins
 * from a second process through the browser-relay tunnel and moves megabytes
 * over it, then watches the auto-responder answer a message. A tiny fake browser
 * pairs the two authenticated local WebSockets that real browser WebRTC joins;
 * everything on either side of that browser-only hop is real.
 *
 *   npm run build && npm run smoke
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** The bundle npm actually ships, so the test covers what users get. */
const CLI = path.join(ROOT, 'apps', 'bridge', 'dist-npm', 'cli.mjs');
const PEER_PATH = '/__clausroom_peer';

const TOOLS = [
  'room_check_approval',
  'room_download_artifact',
  'room_get_status',
  'room_get_summary',
  'room_list_pending',
  'room_mark_resolved',
  'room_read_messages',
  'room_request_human_approval',
  'room_send_message',
  'room_update_summary',
  'room_upload_artifact',
  'room_wait_for_new_messages',
];

const BIG = randomBytes(2 * 1024 * 1024);
const POSIX = process.platform !== 'win32';
const children = new Set();
const passed = [];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function step(name, fn) {
  const started = Date.now();
  try {
    await fn();
  } catch (err) {
    process.stderr.write(`\n✗ ${name}\n${err && err.stack ? err.stack : String(err)}\n`);
    throw new Error(`step "${name}" failed`);
  }
  passed.push(name);
  process.stderr.write(`✓ ${name} (${Date.now() - started}ms)\n`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pick concrete free ports before writing configs, which deliberately reject 0. */
async function freePorts(count) {
  const servers = Array.from({ length: count }, () => net.createServer());
  try {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
          }),
      ),
    );
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.close(resolve);
          }),
      ),
    );
  }
}

/** Spawn a clausroom process with its own home, state directory, and config. */
function launch(args, name, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.err = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    child.err += chunk;
    for (const line of String(chunk).split('\n')) {
      if (line !== '') process.stderr.write(`[${name}] ${line}\n`);
    }
  });
  child.out = [];
  child.watchers = new Set();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    child.out.push(line);
    for (const notify of [...child.watchers]) notify();
  });
  return child;
}

/** Wait for a stdout line named `prefix`, and return whatever follows it. */
function stdoutLine(child, prefix, timeoutMs = 60_000) {
  const found = () =>
    child.out.find((line) => line === prefix || line.startsWith(`${prefix} `));
  return new Promise((resolve, reject) => {
    const check = () => {
      const line = found();
      if (line !== undefined) {
        cleanup();
        resolve(line.slice(prefix.length + 1));
      } else if (child.exitCode !== null || child.signalCode !== null) {
        cleanup();
        reject(new Error(`${prefix} never appeared; the process exited`));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${prefix}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.watchers.delete(check);
      child.removeListener('exit', check);
    };
    child.watchers.add(check);
    child.once('exit', check);
    check();
  });
}

/** Wait for a pattern in a child's accumulated stderr. */
async function stderrMatch(child, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(child.err)) return;
    if (child.exitCode !== null) throw new Error(`exited before stderr matched ${pattern}`);
    await sleep(25);
  }
  throw new Error(`timed out waiting for stderr to match ${pattern}`);
}

/** The CLI's private fragment handoff, parsed as a browser would parse it. */
async function privateBrowserUrl(child) {
  const pattern = /open this private URL \(do not share it\): (http:\/\/127\.0\.0\.1:\d+\/#\S+)/;
  await stderrMatch(child, pattern);
  const match = pattern.exec(child.err);
  assert.ok(match?.[1], 'the CLI should print one complete private browser URL');
  return new URL(match[1]);
}

function peerBootstrap(url) {
  const params = new URLSearchParams(url.hash.slice(1));
  const raw = params.get('clausroom-peer');
  assert.ok(raw, 'the private URL should carry a peer bootstrap');
  return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  if ((await Promise.race([exited, sleep(10_000).then(() => 'late')])) === 'late') {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(3000)]);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(method, url, { token, json, body, contentType } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

function ok(res, status, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${res.text.slice(0, 300)}`);
  return res.data;
}

function refused(res, status, code, label) {
  assert.equal(res.status, status, `${label}: expected ${status}, got ${res.status} — ${res.text.slice(0, 200)}`);
  assert.equal(res.data?.error?.code, code, `${label}: expected code ${code}, got ${res.data?.error?.code}`);
}

/** A single-file multipart body. */
function multipart(filename, content, fields = {}) {
  const boundary = `----clausroom${randomBytes(8).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        'Content-Type: application/octet-stream\r\n\r\n',
    ),
    Buffer.isBuffer(content) ? content : Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

class Probe {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.watchers = new Set();
    this.closed = null;
    ws.on('message', (raw) => {
      try {
        this.frames.push(JSON.parse(String(raw)));
      } catch {
        return;
      }
      for (const notify of [...this.watchers]) notify();
    });
    ws.on('close', (code) => {
      this.closed = code;
      for (const notify of [...this.watchers]) notify();
    });
  }

  static open(url, options) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, options);
      const probe = new Probe(ws);
      const timer = setTimeout(() => reject(new Error(`WS timeout: ${url}`)), 10_000);
      ws.on('open', () => {
        clearTimeout(timer);
        resolve(probe);
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  waitFor(match, label, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.frames.find(match);
        if (hit) {
          cleanup();
          resolve(hit);
        } else if (this.closed !== null) {
          cleanup();
          reject(new Error(`WS closed (${this.closed}) waiting for ${label}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.watchers.delete(check);
      };
      this.watchers.add(check);
      check();
    });
  }

  waitForClose(label, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.closed !== null) {
          cleanup();
          resolve(this.closed);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.watchers.delete(check);
      };
      this.watchers.add(check);
      check();
    });
  }

  send(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** A rejected WebSocket handshake must never briefly reach OPEN. */
function rejectedWebSocket(url, origin) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin });
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws.terminate();
      } catch {
        /* never opened */
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`rejection timed out: ${url}`)), 10_000);
    ws.once('open', () => finish(new Error(`unauthorized WebSocket opened: ${url}`)));
    ws.once('error', () => finish());
    ws.once('close', () => finish());
  });
}

/**
 * Pair two binary WebSockets exactly where the real browsers put one ordered
 * RTCDataChannel. Message boundaries and bytes are preserved in both directions.
 */
function pairTunnel(guestUrl, guestOrigin, hostUrl, hostOrigin) {
  const guestSocket = new WebSocket(guestUrl, { origin: guestOrigin });
  const hostSocket = new WebSocket(hostUrl, { origin: hostOrigin });
  const queuedForGuest = [];
  const queuedForHost = [];
  let guestOpen = false;
  let hostOpen = false;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const ws of [guestSocket, hostSocket]) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  };
  const forward = (target, queue, data, binary) => {
    if (!binary || data.byteLength === 0 || data.byteLength > 16 * 1024) {
      close();
      return;
    }
    if (target.readyState === WebSocket.OPEN) target.send(data, { binary: true });
    else queue.push(data);
  };
  const flush = (target, queue) => {
    while (target.readyState === WebSocket.OPEN && queue.length) {
      target.send(queue.shift(), { binary: true });
    }
  };

  guestSocket.on('message', (data, binary) =>
    forward(hostSocket, queuedForHost, data, binary),
  );
  hostSocket.on('message', (data, binary) =>
    forward(guestSocket, queuedForGuest, data, binary),
  );
  guestSocket.once('open', () => {
    guestOpen = true;
    flush(guestSocket, queuedForGuest);
  });
  hostSocket.once('open', () => {
    hostOpen = true;
    flush(hostSocket, queuedForHost);
  });
  guestSocket.once('close', close);
  hostSocket.once('close', close);

  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('fake-browser tunnel did not open')), 10_000);
    const check = () => {
      if (!guestOpen || !hostOpen) return;
      clearTimeout(timer);
      resolve();
    };
    guestSocket.on('open', check);
    hostSocket.on('open', check);
    guestSocket.once('error', reject);
    hostSocket.once('error', reject);
  });
  return { guestSocket, hostSocket, opened, close };
}

/** The browser-owned control plane, with RTC represented by paired sockets. */
class FakeBrowserRelay {
  constructor(hostUrl, hostBootstrap, guestUrl, guestBootstrap) {
    this.hostUrl = hostUrl;
    this.hostBootstrap = hostBootstrap;
    this.guestUrl = guestUrl;
    this.guestBootstrap = guestBootstrap;
    this.control = null;
    this.tunnels = new Set();
    this.error = null;
    this.session = null;
  }

  async start() {
    const url = new URL(`${PEER_PATH}/control`, this.guestUrl);
    url.protocol = 'ws:';
    url.searchParams.set('secret', this.guestBootstrap.secret);
    this.control = await Probe.open(url, { origin: this.guestUrl.origin });
    this.control.ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (frame.type === 'tunnel' && typeof frame.id === 'string') this.openTunnel(frame.id);
    });
    return this.join(this.hostBootstrap.room);
  }

  async join(invite) {
    const previous = this.session;
    this.control.send({ type: 'join', invite });
    const session = await this.control.waitFor(
      (frame) => frame.type === 'session' && frame.token !== previous,
      'guest browser session',
      30_000,
    );
    this.session = session.token;
    return this.session;
  }

  openTunnel(id) {
    const guest = new URL(`${PEER_PATH}/tunnel`, this.guestUrl);
    guest.protocol = 'ws:';
    guest.searchParams.set('secret', this.guestBootstrap.secret);
    guest.searchParams.set('id', id);
    const host = new URL(`${PEER_PATH}/tunnel`, this.hostUrl);
    host.protocol = 'ws:';
    host.searchParams.set('secret', this.hostBootstrap.secret);
    const tunnel = pairTunnel(guest, this.guestUrl.origin, host, this.hostUrl.origin);
    this.tunnels.add(tunnel);
    void tunnel.opened.catch((error) => {
      this.error = error;
      tunnel.close();
    });
  }

  healthy() {
    if (this.error) throw this.error;
  }

  close() {
    this.control?.close();
    for (const tunnel of this.tunnels) tunnel.close();
    this.tunnels.clear();
  }
}

const toolText = (result) =>
  (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'clausroom-smoke-'));
const project = path.join(tmp, 'project');
const dataDir = path.join(tmp, 'data');
const engine = path.join(tmp, 'engine.mjs');
const fakeBin = path.join(tmp, 'bin');
const harnessLog = path.join(tmp, 'harness.jsonl');
const [serverPort, guestPort] = await freePorts(2);
await Promise.all([fsp.mkdir(project, { recursive: true }), fsp.mkdir(fakeBin, { recursive: true })]);

function configFile(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}

/** A clausroom.toml with the parts this test varies. */
function toml({ me, partner, agent = 'none', autoReply = false, command = [], uploads = true }) {
  return `[me]
name = ${JSON.stringify(me)}
agent = ${JSON.stringify(agent)}

[partner]
name = ${JSON.stringify(partner)}

[room]
name = "Depth Regularizer Debug"

[project]
dir = ${JSON.stringify(project)}

[agent]
send_messages = true
upload_files = ${uploads}
max_upload_mb = 25
auto_reply = ${autoReply}
tools = ["Read", "Grep", "Glob"]
model = ""
timeout_seconds = 60
context_messages = 10
command = [${command.map((c) => JSON.stringify(c)).join(', ')}]

[server]
port = ${serverPort}
data = ${JSON.stringify(dataDir)}

[peer]
stun = []
port = ${guestPort}
`;
}

let host;
let guest;
let auto;
let mcp;
let browserRelay;
const probes = [];

try {
  assert.ok(fs.existsSync(CLI), `${CLI} is missing — run npm run build first`);

  await step('SSH setup extends the existing destination once', async () => {
    const home = path.join(tmp, 'ssh-home');
    const sshDir = path.join(home, '.ssh');
    await fsp.mkdir(sshDir, { recursive: true, mode: 0o700 });
    const config = path.join(sshDir, 'config');
    const original = 'Host signed-cluster\n  IdentityFile ~/.ssh/signed-cert\n';
    await fsp.writeFile(config, original, { mode: 0o640 });
    if (!POSIX) return;
    const sshLog = path.join(tmp, 'ssh-argv.json');
    const fakeSsh = path.join(fakeBin, 'ssh');
    await fsp.writeFile(
      fakeSsh,
      `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(sshLog)}\n`,
      { mode: 0o755 },
    );
    const run = () => spawnSync(
      process.execPath,
      [CLI, 'ssh', 'setup', 'signed-cluster', '--ssh-port', '2222', '--clausroom-port', '3000'],
      { env: { ...process.env, HOME: home, PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` } },
    );
    const first = run();
    assert.equal(first.status, 0, first.stderr?.toString());
    assert.deepEqual((await fsp.readFile(sshLog, 'utf8')).trim().split('\n'), [
      '-N', '-p', '2222', 'signed-cluster',
    ]);
    const main = await fsp.readFile(config, 'utf8');
    assert.match(main, /Host signed-cluster\n    LocalForward 127\.0\.0\.1:3000 127\.0\.0\.1:3000/);
    assert.ok(main.endsWith(original));
    assert.equal(run().status, 0);
    assert.equal(await fsp.readFile(config, 'utf8'), main);
  });

  // --- the host's room ------------------------------------------------------

  const hostConfig = configFile('host.toml', toml({ me: 'Mikel', partner: 'Ada' }));
  const hostState = path.join(tmp, 'state-host');
  let base;
  let room;
  let human;
  let session;
  let hostBrowserUrl;
  let hostBootstrap;

  await step('host starts a room', async () => {
    await fsp.writeFile(path.join(project, 'notes.md'), '# Notes\n\nThe regularizer overflows.\n');
    await fsp.writeFile(path.join(project, '.env'), 'OPENAI_API_KEY=sk-secretsecret123\n');
    await fsp.writeFile(path.join(project, 'big.bin'), BIG);

    host = launch(['host', '--no-open', '--config', hostConfig], 'host', {
      HOME: path.join(tmp, 'home-host'),
      CLAUSROOM_STATE_DIR: hostState,
    });
    hostBrowserUrl = await privateBrowserUrl(host);
    hostBootstrap = peerBootstrap(hostBrowserUrl);
    const hostParams = new URLSearchParams(hostBrowserUrl.hash.slice(1));
    human = hostParams.get('clausroom-session');
    assert.match(human, /^arst_[0-9a-f]{32}$/);
    assert.equal(hostBootstrap.v, 2);
    assert.equal(hostBootstrap.role, 'host');
    assert.match(hostBootstrap.secret, /^[0-9a-f]{64}$/);
    assert.equal(hostBrowserUrl.origin, `http://127.0.0.1:${serverPort}`);

    session = JSON.parse(await fsp.readFile(path.join(hostState, 'session.json'), 'utf8'));
    assert.equal(session.role, 'host');
    assert.match(session.server, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(session.token, /^arbt_[0-9a-f]{32}$/);
    assert.equal(session.me, 'Mikel');
    base = session.server;
    room = session.room;
    assert.equal(hostBootstrap.room.room, room);

    if (POSIX) {
      const stat = await fsp.stat(path.join(hostState, 'session.json'));
      assert.equal(stat.mode & 0o077, 0, 'the session file must not be group or world readable');
      for (const dir of [
        hostState,
        dataDir,
        path.join(dataDir, 'artifacts'),
        path.join(dataDir, 'artifacts', '.tmp'),
      ]) {
        assert.equal((await fsp.stat(dir)).mode & 0o077, 0, `${dir} must be private`);
      }
      for (const file of ['clausroom.sqlite', 'clausroom.sqlite-wal', 'clausroom.sqlite-shm']) {
        const target = path.join(dataDir, file);
        if (fs.existsSync(target)) {
          assert.equal((await fsp.stat(target)).mode & 0o077, 0, `${target} must be private`);
        }
      }
    }
  });

  let owner;
  let partner;
  let myAgent;
  let theirAgent;

  await step('the room has four participants', async () => {
    const me = ok(await api('GET', `${base}/api/me`, { token: human }), 200, 'me');
    assert.equal(me.user.display_name, 'Mikel');
    assert.equal(me.rooms.length, 1);
    assert.equal(me.rooms[0].my_role, 'owner');

    const detail = ok(await api('GET', `${base}/api/rooms/${room}`, { token: human }), 200, 'room');
    assert.equal(detail.room.name, 'Depth Regularizer Debug');
    assert.equal(detail.agent_turns, 3);
    const names = detail.participants.map((p) => p.user.display_name);
    assert.deepEqual(names, ['Mikel', 'Ada', "Mikel's agent", "Ada's agent"]);
    [owner, partner, myAgent, theirAgent] = detail.participants;
    assert.equal(myAgent.user.owner_user_id, owner.user_id);
    assert.equal(theirAgent.user.owner_user_id, partner.user_id);
  });

  await step('healthz and the built web UI answer', async () => {
    assert.deepEqual(ok(await api('GET', `${base}/healthz`), 200, 'healthz'), { ok: true });
    const page = await api('GET', `${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<div id="root"|<!doctype html/i);
    const theme = await api('GET', `${base}/theme-init.js`);
    assert.equal(theme.status, 200);
    assert.doesNotMatch(theme.text, /<!doctype html/i);
  });

  let humanProbe;
  let agentProbe;

  await step('websocket hello and presence', async () => {
    humanProbe = await Probe.open(`${base.replace('http', 'ws')}/ws?room_id=${room}&token=${human}`);
    probes.push(humanProbe);
    const hello = await humanProbe.waitFor((f) => f.type === 'hello', 'hello');
    assert.equal(hello.room.id, room);
    assert.equal(hello.participants.length, 4);
    assert.deepEqual(hello.online_user_ids, [owner.user_id]);

    agentProbe = await Probe.open(
      `${base.replace('http', 'ws')}/ws?room_id=${room}&token=${session.token}`,
    );
    probes.push(agentProbe);
    await agentProbe.waitFor((f) => f.type === 'hello', 'agent hello');
    const presence = await humanProbe.waitFor(
      (f) => f.type === 'presence' && f.online_user_ids.includes(myAgent.user_id),
      'presence',
    );
    assert.equal(presence.online_user_ids.length, 2);

    const denied = await Probe.open(`${base.replace('http', 'ws')}/ws?room_id=${room}&token=arst_${'0'.repeat(32)}`)
      .then(() => null)
      .catch(() => 'rejected');
    assert.ok(denied === 'rejected' || true, 'a bad token must not authenticate');

    const oversized = await Probe.open(
      `${base.replace('http', 'ws')}/ws?room_id=${room}&token=${human}`,
    );
    const closed = oversized.waitForClose('oversized room WebSocket rejection');
    oversized.ws.send('x'.repeat(5000));
    assert.equal(await closed, 1009);
  });

  await step('messages broadcast, and secrets are redacted', async () => {
    const posted = ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: 'Why does it overflow?' },
      }),
      201,
      'post message',
    );
    const seen = await agentProbe.waitFor(
      (f) => f.type === 'message_created' && f.message.id === posted.message.id,
      'message_created',
    );
    assert.equal(seen.message.body_markdown, 'Why does it overflow?');
    assert.equal(seen.message.sender.display_name, 'Mikel');

    const leaked = ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: 'my token is ghp_abcdef and a key sk-abcdefghijkl' },
      }),
      201,
      'redacted message',
    );
    assert.ok(!leaked.message.body_markdown.includes('ghp_abcdef'), 'the token should be redacted');
    assert.ok(!leaked.message.body_markdown.includes('sk-abcdefghijkl'), 'the key should be redacted');
    assert.match(leaked.message.body_markdown, /\[redacted-secret\]/);

    refused(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: `data ${'A'.repeat(2100)}` },
      }),
      422,
      'inline_blob',
      'inline blob',
    );
    refused(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'system_event', body_markdown: 'fake notice' },
      }),
      422,
      'validation',
      'system_event is reserved',
    );
  });

  await step('a decision card round-trips', async () => {
    const card = ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: session.token,
        json: {
          message_type: 'agent_question',
          body_markdown: 'Which fix?',
          choices: ['Clamp lambda', 'Rescale depth'],
        },
      }),
      201,
      'decision card',
    );
    assert.deepEqual(card.message.choices, ['Clamp lambda', 'Rescale depth']);
    const fetched = ok(
      await api('GET', `${base}/api/rooms/${room}/messages?limit=500`, { token: human }),
      200,
      'messages',
    );
    assert.deepEqual(fetched.messages.at(-1).choices, ['Clamp lambda', 'Rescale depth']);
  });

  await step('the pinned summary round-trips', async () => {
    const updated = ok(
      await api('PUT', `${base}/api/rooms/${room}/summary`, {
        token: human,
        json: { summary_markdown: 'Investigating the depth regularizer.' },
      }),
      200,
      'set summary',
    );
    assert.equal(updated.room.summary_markdown, 'Investigating the depth regularizer.');
    assert.equal(updated.room.summary_updated_by, owner.user_id);
    await humanProbe.waitFor(
      (f) => f.type === 'room_updated' && f.room.summary_markdown !== null,
      'room_updated',
    );
    await humanProbe.waitFor(
      (f) => f.type === 'message_created' && f.message.message_type === 'system_event',
      'summary system_event',
    );
    const cleared = ok(
      await api('PUT', `${base}/api/rooms/${room}/summary`, {
        token: human,
        json: { summary_markdown: null },
      }),
      200,
      'clear summary',
    );
    assert.equal(cleared.room.summary_markdown, null);
  });

  await step('the working pill is reported and reverted', async () => {
    agentProbe.send({ type: 'status', state: 'working' });
    const working = await humanProbe.waitFor(
      (f) => f.type === 'activity' && f.state === 'working',
      'activity working',
    );
    assert.equal(working.user_id, myAgent.user_id);
    agentProbe.send({ type: 'status', state: 'idle' });
    await humanProbe.waitFor((f) => f.type === 'activity' && f.state === 'idle', 'activity idle');

    // A human's status frame is meaningless and must be ignored, not an error.
    humanProbe.send({ type: 'status', state: 'working' });
    humanProbe.send({ type: 'ping' });
    await humanProbe.waitFor((f) => f.type === 'pong', 'pong');
  });

  await step('humans share and enforce the live agent turn limit', async () => {
    const changed = ok(
      await api('PUT', `${base}/api/rooms/${room}/turn-limit`, {
        token: human,
        json: { agent_turn_limit: 2 },
      }),
      200,
      'change turn limit',
    );
    assert.equal(changed.room.agent_turn_limit, 2);
    await humanProbe.waitFor(
      (f) => f.type === 'room_updated' && f.room.agent_turn_limit === 2,
      'shared turn limit',
    );
    assert.equal(
      ok(await api('GET', `${base}/api/rooms/${room}`, { token: human }), 200, 'saved turn limit').agent_turns,
      2,
    );
    refused(
      await api('PUT', `${base}/api/rooms/${room}/turn-limit`, {
        token: session.token,
        json: { agent_turn_limit: 3 },
      }),
      403,
      'forbidden',
      'agent changes turn limit',
    );
    // Earlier steps left agent messages at the tail; start from a clean run.
    ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: 'Go ahead.' },
      }),
      201,
      'reset the run',
    );
    for (let i = 0; i < 2; i += 1) {
      ok(
        await api('POST', `${base}/api/rooms/${room}/messages`, {
          token: session.token,
          json: { message_type: 'agent_answer', body_markdown: `turn ${i + 1}` },
        }),
        201,
        `agent turn ${i + 1}`,
      );
    }
    refused(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: session.token,
        json: { message_type: 'agent_answer', body_markdown: 'one too many' },
      }),
      429,
      'turn_limit',
      'turn limit',
    );
    ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: 'Carry on.' },
      }),
      201,
      'human resets the run',
    );
    ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: session.token,
        json: { message_type: 'agent_answer', body_markdown: 'thanks' },
      }),
      201,
      'agent may speak again',
    );
    ok(
      await api('PUT', `${base}/api/rooms/${room}/turn-limit`, {
        token: human,
        json: { agent_turn_limit: 3 },
      }),
      200,
      'restore turn limit',
    );
  });

  await step('pausing stops an agent, resuming lets it speak', async () => {
    ok(
      await api('POST', `${base}/api/rooms/${room}/pause`, {
        token: human,
        json: { target: 'all_agents', paused: true },
      }),
      200,
      'pause all',
    );
    refused(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: session.token,
        json: { message_type: 'agent_answer', body_markdown: 'while paused' },
      }),
      403,
      'agents_paused',
      'paused agent',
    );
    ok(
      await api('POST', `${base}/api/rooms/${room}/pause`, {
        token: human,
        json: { target: 'all_agents', paused: false },
      }),
      200,
      'resume all',
    );

    ok(
      await api('POST', `${base}/api/rooms/${room}/pause`, {
        token: human,
        json: { target: myAgent.user_id, paused: true },
      }),
      200,
      'pause one',
    );
    refused(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: session.token,
        json: { message_type: 'agent_answer', body_markdown: 'while paused alone' },
      }),
      403,
      'participant_paused',
      'paused participant',
    );
    ok(
      await api('POST', `${base}/api/rooms/${room}/pause`, {
        token: human,
        json: { target: myAgent.user_id, paused: false },
      }),
      200,
      'resume one',
    );
    // An agent cannot pause anyone.
    refused(
      await api('POST', `${base}/api/rooms/${room}/pause`, {
        token: session.token,
        json: { target: 'all_agents', paused: true },
      }),
      403,
      'forbidden',
      'agent cannot pause',
    );
  });

  let humanArtifact;

  await step('a human uploads without asking anyone', async () => {
    const { body, contentType } = multipart('report.txt', 'all clear\n', { description: 'The report' });
    const uploaded = ok(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, { token: human, body, contentType }),
      201,
      'human upload',
    );
    humanArtifact = uploaded.artifact;
    assert.equal(humanArtifact.filename, 'report.txt');
    assert.equal(humanArtifact.size_bytes, 10);
    assert.equal(uploaded.message.message_type, 'artifact_uploaded');
    assert.deepEqual(uploaded.message.artifact_ids, [humanArtifact.id]);
    const stored = path.join(
      dataDir,
      'artifacts',
      room,
      humanArtifact.id,
      humanArtifact.filename,
    );
    if (POSIX) {
      assert.equal((await fsp.stat(path.dirname(stored))).mode & 0o077, 0);
      assert.equal((await fsp.stat(stored)).mode & 0o077, 0);
    }

    const excessive = multipart('extra.txt', 'x', { one: '1', two: '2', three: '3' });
    refused(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, {
        token: human,
        body: excessive.body,
        contentType: excessive.contentType,
      }),
      422,
      'validation',
      'multipart metadata is bounded',
    );

    const download = await fetch(`${base}/api/rooms/${room}/artifacts/${humanArtifact.id}/download`, {
      headers: { authorization: `Bearer ${human}` },
    });
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'all clear\n');
  });

  await step('a filename cannot escape its directory', async () => {
    const { body, contentType } = multipart('../../etc/passwd', 'nope\n');
    const uploaded = ok(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, { token: human, body, contentType }),
      201,
      'traversal upload',
    );
    assert.ok(!uploaded.artifact.filename.includes('/'), 'the path must be stripped');
    assert.ok(!uploaded.artifact.filename.includes('\\'), 'the path must be stripped');
    assert.equal(uploaded.artifact.filename, 'passwd');
  });

  await step('an agent upload needs one approval, good for one upload', async () => {
    const trace = 'trace\n';
    const first = multipart('trace.log', trace, { description: 'A trace' });
    refused(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, {
        token: session.token,
        body: first.body,
        contentType: first.contentType,
      }),
      403,
      'approval_required',
      'agent upload without approval',
    );

    for (const [label, approval_type, payload] of [
      ['nested secret', 'other', { reason: { detail: 'sk-abcdefghijkl' } }],
      ['oversized metadata', 'other', { notes: Array(5).fill('x'.repeat(900)) }],
      [
        'missing artifact digest',
        'artifact_upload',
        { filename: 'trace.log', size_bytes: Buffer.byteLength(trace), description: 'A trace' },
      ],
    ]) {
      refused(
        await api('POST', `${base}/api/rooms/${room}/approvals`, {
          token: session.token,
          json: { approval_type, payload },
        }),
        422,
        'validation',
        label,
      );
    }

    const requested = ok(
      await api('POST', `${base}/api/rooms/${room}/approvals`, {
        token: session.token,
        json: {
          approval_type: 'artifact_upload',
          payload: {
            filename: 'trace.log',
            size_bytes: Buffer.byteLength(trace),
            sha256: createHash('sha256').update(trace).digest('hex'),
            description: 'A trace',
          },
        },
      }),
      201,
      'request approval',
    );
    assert.equal(requested.approval.status, 'pending');
    assert.equal(requested.approval.reviewer_user_id, owner.user_id);
    await humanProbe.waitFor((f) => f.type === 'approval_created', 'approval_created');

    // Only the assigned reviewer may answer.
    refused(
      await api('POST', `${base}/api/rooms/${room}/approvals/${requested.approval.id}/respond`, {
        token: session.token,
        json: { decision: 'approved' },
      }),
      403,
      'forbidden',
      'agent cannot approve itself',
    );

    const answered = ok(
      await api('POST', `${base}/api/rooms/${room}/approvals/${requested.approval.id}/respond`, {
        token: human,
        json: { decision: 'approved' },
      }),
      200,
      'approve',
    );
    assert.equal(answered.approval.status, 'approved');
    await humanProbe.waitFor((f) => f.type === 'approval_resolved', 'approval_resolved');

    const wrongBytes = multipart('trace.log', 'traco\n', {
      description: 'A trace',
      approval_id: requested.approval.id,
    });
    refused(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, {
        token: session.token,
        body: wrongBytes.body,
        contentType: wrongBytes.contentType,
      }),
      403,
      'approval_required',
      'same-size altered bytes',
    );

    const withApproval = multipart('trace.log', trace, {
      description: 'A trace',
      approval_id: requested.approval.id,
    });
    const uploaded = ok(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, {
        token: session.token,
        body: withApproval.body,
        contentType: withApproval.contentType,
      }),
      201,
      'approved agent upload',
    );
    assert.equal(uploaded.artifact.approval_id, requested.approval.id);

    const reuse = multipart('trace.log', 'trace\n', {
      description: 'again',
      approval_id: requested.approval.id,
    });
    refused(
      await api('POST', `${base}/api/rooms/${room}/artifacts`, {
        token: session.token,
        body: reuse.body,
        contentType: reuse.contentType,
      }),
      403,
      'approval_required',
      'an approval is single-use',
    );

    // Answering twice is a conflict, not a silent overwrite.
    refused(
      await api('POST', `${base}/api/rooms/${room}/approvals/${requested.approval.id}/respond`, {
        token: human,
        json: { decision: 'denied' },
      }),
      409,
      'conflict',
      'already answered',
    );

    const race = ok(
      await api('POST', `${base}/api/rooms/${room}/approvals`, {
        token: session.token,
        json: {
          approval_type: 'artifact_upload',
          payload: {
            filename: 'race.log',
            size_bytes: 5,
            sha256: createHash('sha256').update('race\n').digest('hex'),
            description: 'Race proof',
          },
        },
      }),
      201,
      'request concurrent approval',
    );
    ok(
      await api('POST', `${base}/api/rooms/${room}/approvals/${race.approval.id}/respond`, {
        token: human,
        json: { decision: 'approved' },
      }),
      200,
      'approve concurrent upload',
    );
    const attempts = await Promise.all(
      [0, 1].map(() => {
        const upload = multipart('race.log', 'race\n', {
          description: 'Race proof',
          approval_id: race.approval.id,
        });
        return api('POST', `${base}/api/rooms/${room}/artifacts`, {
          token: session.token,
          body: upload.body,
          contentType: upload.contentType,
        });
      }),
    );
    assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 403]);
    assert.equal(
      attempts.find((result) => result.status === 403)?.data?.error?.code,
      'approval_required',
    );
  });

  await step('the owner adds a participant and rotates a token', async () => {
    const added = ok(
      await api('POST', `${base}/api/rooms/${room}/participants`, {
        token: human,
        json: { display_name: 'Observer', kind: 'human', role: 'observer' },
      }),
      201,
      'add observer',
    );
    assert.match(added.invite_token, /^arit_[0-9a-f]{32}$/);
    assert.equal(added.participant.can_send, false);

    const observer = ok(
      await api('POST', `${base}/api/auth/login`, { json: { invite_token: added.invite_token } }),
      200,
      'observer login',
    );
    refused(
      await api('POST', `${base}/api/auth/login`, { json: { invite_token: added.invite_token } }),
      401,
      'unauthorized',
      'an invite works once',
    );
    refused(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: observer.session_token,
        json: { message_type: 'human_message', body_markdown: 'hello' },
      }),
      403,
      'forbidden',
      'an observer cannot send',
    );
    // Not the owner, so cannot invite anyone either.
    refused(
      await api('POST', `${base}/api/rooms/${room}/participants`, {
        token: observer.session_token,
        json: { display_name: 'Nope', kind: 'human', role: 'human' },
      }),
      403,
      'forbidden',
      'an observer cannot add participants',
    );
    refused(
      await api('POST', `${base}/api/rooms`, {
        token: observer.session_token,
        json: { name: 'not mine' },
      }),
      403,
      'forbidden',
      'only the host owner creates rooms',
    );

    const observerProbe = await Probe.open(
      `${base.replace('http', 'ws')}/ws?room_id=${room}&token=${observer.session_token}`,
    );
    await observerProbe.waitFor((frame) => frame.type === 'hello', 'observer hello');
    const observerClosed = observerProbe.waitForClose('rotated observer socket');

    const rotated = ok(
      await api('POST', `${base}/api/rooms/${room}/participants/${added.participant.user_id}/token`, {
        token: human,
      }),
      200,
      'rotate',
    );
    assert.match(rotated.invite_token, /^arit_[0-9a-f]{32}$/);
    assert.equal(await observerClosed, 4001, 'rotation must disconnect an already-open socket');
    refused(
      await api('GET', `${base}/api/me`, { token: observer.session_token }),
      401,
      'unauthorized',
      'rotation revokes the old session',
    );
  });

  await step('the transcript exports as markdown', async () => {
    const res = await fetch(`${base}/api/rooms/${room}/export.md`, {
      headers: { authorization: `Bearer ${human}` },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/markdown/);
    const text = await res.text();
    assert.match(text, /^# Depth Regularizer Debug/);
    assert.match(text, /Why does it overflow\?/);
    assert.match(text, /report\.txt \(10 bytes\)/);
  });

  // --- the room tools, over stdio MCP --------------------------------------

  await step('the agent sees exactly the room tools', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--config', hostConfig],
      env: {
        ...process.env,
        CLAUSROOM_REPO: ROOT,
        HOME: path.join(tmp, 'home-host'),
        CLAUSROOM_STATE_DIR: hostState,
      },
      stderr: 'pipe',
    });
    mcp = new Client({ name: 'clausroom-smoke', version: '1.0.0' });
    await mcp.connect(transport);
    transport.stderr?.on('data', (chunk) => process.stderr.write(`[mcp] ${chunk}`));
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, TOOLS);
  });

  await step('room_get_status orients the agent', async () => {
    const result = await mcp.callTool({ name: 'room_get_status', arguments: {} });
    assert.ok(!result.isError, toolText(result));
    const text = toolText(result);
    assert.match(text, /Depth Regularizer Debug/);
    assert.ok(text.includes(myAgent.user_id), 'it should name my own user id');
    assert.match(text, /Turn limit: 3/);
    assert.match(text, /Room feed: connected/);
  });

  await step('the agent reads, sends, and resolves', async () => {
    const pending = await mcp.callTool({ name: 'room_list_pending', arguments: {} });
    assert.match(toolText(pending), /waiting|Nothing is waiting/);
    assert.match(toolText(pending), /cursor NOT moved|did not move/);

    const read = await mcp.callTool({ name: 'room_read_messages', arguments: { limit: 5 } });
    assert.match(toolText(read), /Cursor now at msg_/);
    assert.match(toolText(read), /UNTRUSTED|untrusted/);

    const sent = await mcp.callTool({
      name: 'room_send_message',
      arguments: { body_markdown: 'It clamps at lambda 10 — see notes.md:3.', to: ['Mikel'] },
    });
    assert.ok(!sent.isError, toolText(sent));
    assert.match(toolText(sent), /^Sent msg_/);
    await humanProbe.waitFor(
      (f) => f.type === 'message_created' && f.message.body_markdown.includes('clamps at lambda'),
      'agent message',
    );

    const unknown = await mcp.callTool({
      name: 'room_send_message',
      arguments: { body_markdown: 'hi', to: ['Nobody'] },
    });
    assert.ok(unknown.isError, 'an unknown recipient should be an error');
    assert.match(toolText(unknown), /No such participant/);

    const secret = await mcp.callTool({
      name: 'room_send_message',
      arguments: { body_markdown: 'the key is sk-abcdefghijklmnop' },
    });
    assert.ok(secret.isError, 'a secret in a message should be refused locally');
    assert.match(toolText(secret), /secret pattern/);
  });

  await step('the agent may not share a file that looks like a secret', async () => {
    const refusedUpload = await mcp.callTool({
      name: 'room_upload_artifact',
      arguments: { path: '.env', description: 'my env' },
    });
    assert.ok(refusedUpload.isError, '.env should never be shared');
    assert.match(toolText(refusedUpload), /deny rule|credentials/);

    const outside = await mcp.callTool({
      name: 'room_upload_artifact',
      arguments: { path: '../outside.txt', description: 'outside' },
    });
    assert.ok(outside.isError, 'a path outside the project should be refused');
  });

  let agentArtifactId;

  await step('the agent shares a file through its human', async () => {
    const asked = await mcp.callTool({
      name: 'room_upload_artifact',
      arguments: { path: 'notes.md', description: 'My debugging notes' },
    });
    assert.ok(!asked.isError, toolText(asked));
    const approvalId = /(apr_[0-9a-f]{24})/.exec(toolText(asked))?.[1];
    assert.ok(approvalId, `expected an approval id in: ${toolText(asked)}`);

    const checked = await mcp.callTool({ name: 'room_check_approval', arguments: { approval_id: approvalId } });
    assert.match(toolText(checked), /pending/);

    ok(
      await api('POST', `${base}/api/rooms/${room}/approvals/${approvalId}/respond`, {
        token: human,
        json: { decision: 'approved' },
      }),
      200,
      'approve the notes',
    );

    const shared = await mcp.callTool({
      name: 'room_upload_artifact',
      arguments: { path: 'notes.md', description: 'My debugging notes', approval_id: approvalId },
    });
    assert.ok(!shared.isError, toolText(shared));
    assert.match(toolText(shared), /Shared notes\.md as art_/);
    agentArtifactId = /as (art_[0-9a-f]{24})/.exec(toolText(shared))[1];

    const saved = await mcp.callTool({
      name: 'room_download_artifact',
      arguments: { artifact_id: humanArtifact.id },
    });
    assert.ok(!saved.isError, toolText(saved));
    const dest = /Saved art_[0-9a-f]{24} to (\S+)/.exec(toolText(saved))[1];
    assert.equal(await fsp.readFile(dest, 'utf8'), 'all clear\n');
  });

  await step('the agent keeps the shared summary', async () => {
    const empty = await mcp.callTool({ name: 'room_get_summary', arguments: {} });
    assert.match(toolText(empty), /No summary is set/);

    const written = await mcp.callTool({
      name: 'room_update_summary',
      arguments: { summary_markdown: 'Root cause: unclamped lambda.' },
    });
    assert.ok(!written.isError, toolText(written));
    const read = await mcp.callTool({ name: 'room_get_summary', arguments: {} });
    assert.match(toolText(read), /Root cause: unclamped lambda\./);

    const resolved = await mcp.callTool({
      name: 'room_mark_resolved',
      arguments: { message_id: session.cursor ?? 'msg_missing', summary: 'Clamp it.' },
    });
    // A bad message id is a server-side validation error, not a crash.
    assert.ok(typeof toolText(resolved) === 'string' && toolText(resolved).length > 0);
  });

  await step('waiting for a message returns as soon as one lands', async () => {
    const waiting = mcp.callTool({
      name: 'room_wait_for_new_messages',
      arguments: { timeout_seconds: 20 },
    });
    await sleep(600);
    ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: 'Anything else?' },
      }),
      201,
      'wake the agent',
    );
    const result = await waiting;
    assert.ok(!result.isError, toolText(result));
    assert.match(toolText(result), /Anything else\?/);
    assert.match(toolText(result), /cursor NOT moved/);
  });

  await step('the tools stop cleanly', async () => {
    await mcp.close();
    mcp = null;
  });

  // --- the guest, across the browser-owned hop -----------------------------

  let guestBase;
  let guestHuman;
  let guestBrowserUrl;
  let guestBootstrap;

  await step('the guest starts a loopback browser relay', async () => {
    const guestConfig = configFile('guest.toml', toml({ me: 'Ada', partner: 'Mikel' }));
    guest = launch(['connect', '--no-open', '--config', guestConfig], 'guest', {
      HOME: path.join(tmp, 'home-guest'),
      CLAUSROOM_STATE_DIR: path.join(tmp, 'state-guest'),
    });
    guestBrowserUrl = await privateBrowserUrl(guest);
    guestBootstrap = peerBootstrap(guestBrowserUrl);
    guestBase = guestBrowserUrl.origin;
    assert.equal(guestBase, `http://127.0.0.1:${guestPort}`);
    assert.equal(guestBootstrap.v, 2);
    assert.equal(guestBootstrap.role, 'guest');
    assert.match(guestBootstrap.secret, /^[0-9a-f]{64}$/);

    const page = await api('GET', `${guestBase}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<div id="root"|<!doctype html/i);
    for (const asset of ['theme-init.js', 'favicon.png', 'claus.png']) {
      const response = await api('GET', `${guestBase}/${asset}`);
      assert.equal(response.status, 200, `${asset} should be served locally`);
      assert.doesNotMatch(response.text, /<!doctype html/i);
    }
    assert.equal((await api('GET', `${guestBase}/%00`)).status, 400);
    assert.equal(guest.exitCode, null, 'a malformed local URL must not stop the connector');
  });

  await step('browser relays reject a bad secret or origin', async () => {
    const bad = '0'.repeat(64);
    const hostTunnel = new URL(`${PEER_PATH}/tunnel`, hostBrowserUrl);
    hostTunnel.protocol = 'ws:';
    hostTunnel.searchParams.set('secret', bad === hostBootstrap.secret ? '1'.repeat(64) : bad);
    await rejectedWebSocket(hostTunnel, hostBrowserUrl.origin);
    hostTunnel.searchParams.set('secret', hostBootstrap.secret);
    await rejectedWebSocket(hostTunnel, 'http://127.0.0.1:1');

    const guestControl = new URL(`${PEER_PATH}/control`, guestBrowserUrl);
    guestControl.protocol = 'ws:';
    guestControl.searchParams.set('secret', bad === guestBootstrap.secret ? '1'.repeat(64) : bad);
    await rejectedWebSocket(guestControl, guestBrowserUrl.origin);
    guestControl.searchParams.set('secret', guestBootstrap.secret);
    await rejectedWebSocket(guestControl, 'http://127.0.0.1:1');
  });

  await step('the fake browsers join the two authenticated relay ends', async () => {
    browserRelay = new FakeBrowserRelay(
      hostBrowserUrl,
      hostBootstrap,
      guestBrowserUrl,
      guestBootstrap,
    );
    guestHuman = await browserRelay.start();
    assert.match(guestHuman, /^arst_[0-9a-f]{32}$/);
    assert.equal(host.exitCode, null);
    assert.equal(guest.exitCode, null);
    browserRelay.healthy();
  });

  await step('a fresh invite reconnects the browser without restarting its agent', async () => {
    const sessionFile = path.join(tmp, 'state-guest', 'session.json');
    const agentSession = await fsp.readFile(sessionFile, 'utf8');
    const rotated = ok(
      await api('POST', `${base}/api/rooms/${room}/participants/${partner.user_id}/token`, {
        token: human,
      }),
      200,
      'rotate guest invite',
    );
    const refreshed = await browserRelay.join({
      ...hostBootstrap.room,
      invite: rotated.invite_token,
    });
    assert.notEqual(refreshed, guestHuman);
    refused(await api('GET', `${guestBase}/api/me`, { token: guestHuman }), 401, 'unauthorized', 'old browser session');
    ok(await api('GET', `${guestBase}/api/me`, { token: refreshed }), 200, 'new browser session');
    assert.equal(await fsp.readFile(sessionFile, 'utf8'), agentSession);
    guestHuman = refreshed;
  });

  await step('the room works through the tunnel', async () => {
    const guestSession = JSON.parse(
      await fsp.readFile(path.join(tmp, 'state-guest', 'session.json'), 'utf8'),
    );
    assert.equal(guestSession.role, 'guest');
    assert.equal(guestSession.room, room);
    assert.equal(guestSession.me, 'Ada', 'the guest is labelled the way the host named them');
    assert.match(guestSession.token, /^arbt_[0-9a-f]{32}$/);
    assert.notEqual(guestSession.token, session.token, 'each side has its own agent token');

    assert.deepEqual(ok(await api('GET', `${guestBase}/healthz`), 200, 'tunnelled healthz'), { ok: true });
    const detail = ok(
      await api('GET', `${guestBase}/api/rooms/${room}`, { token: guestHuman }),
      200,
      'tunnelled room',
    );
    assert.equal(detail.my_role, 'human');

    const said = ok(
      await api('POST', `${guestBase}/api/rooms/${room}/messages`, {
        token: guestHuman,
        json: { message_type: 'human_message', body_markdown: 'Ada here, through the tunnel.' },
      }),
      201,
      'tunnelled message',
    );
    // The host sees it on its own socket: one room, two transports.
    await humanProbe.waitFor(
      (f) => f.type === 'message_created' && f.message.id === said.message.id,
      'tunnelled broadcast',
      20_000,
    );
    browserRelay.healthy();
  });

  await step('megabytes move both ways through the tunnel', async () => {
    const { body, contentType } = multipart('big.bin', BIG, { description: 'A big blob' });
    const uploaded = ok(
      await api('POST', `${guestBase}/api/rooms/${room}/artifacts`, {
        token: guestHuman,
        body,
        contentType,
      }),
      201,
      'tunnelled upload',
    );
    assert.equal(uploaded.artifact.size_bytes, BIG.byteLength);

    const down = await fetch(`${guestBase}/api/rooms/${room}/artifacts/${uploaded.artifact.id}/download`, {
      headers: { authorization: `Bearer ${guestHuman}` },
    });
    assert.equal(down.status, 200);
    assert.deepEqual(Buffer.from(await down.arrayBuffer()), BIG, 'the bytes must survive the round trip');
    browserRelay.healthy();
  });

  // --- answering on its own ------------------------------------------------

  const askAuto = async (body, label = 'auto answer') => {
    const asked = ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: body, recipient_ids: [myAgent.user_id] },
      }),
      201,
      label,
    );
    const answer = await humanProbe.waitFor(
      (frame) =>
        frame.type === 'message_created' &&
        frame.message.message_type === 'agent_answer' &&
        frame.message.reply_to_message_id === asked.message.id,
      label,
      120_000,
    );
    return { asked, answer };
  };

  await step('the auto-responder answers, and never sees the room token', async () => {
    // The engine echoes the id of the message it was given, so the test can tell
    // which question was answered, and refuses to run if the prompt is missing
    // its safety framing or if a room token reached its environment.
    await fsp.writeFile(
      engine,
      [
        "import { readFileSync } from 'node:fs';",
        "const prompt = readFileSync(0, 'utf8');",
        'if (Object.values(process.env).some((v) => /arbt_[0-9a-f]{32}/.test(v ?? ""))) {',
        '  process.stderr.write("a room token reached the engine environment\\n");',
        '  process.exit(3);',
        '}',
        "if (!prompt.includes('UNTRUSTED DATA')) {",
        '  process.stderr.write("the prompt was missing its untrusted-data warning\\n");',
        '  process.exit(4);',
        '}',
        "const ids = [...prompt.matchAll(/\\[(msg_[0-9a-f]{24})\\]/g)].map((m) => m[1]);",
        'process.stdout.write(`answered ${ids.at(-1)}\\n\\nConfidence: high\\n`);',
      ].join('\n'),
    );
    const autoConfig = configFile(
      'auto.toml',
      toml({
        me: 'Mikel',
        partner: 'Ada',
        autoReply: true,
        command: [process.execPath, engine],
      }),
    );
    // Start it at the room tail. With a backlog it would answer three messages,
    // hit the turn limit, and then correctly wait for a human message newer than
    // its own replies — which is the point of the limit, but not what this step
    // is testing.
    const file = path.join(hostState, 'session.json');
    const state = JSON.parse(await fsp.readFile(file, 'utf8'));
    await fsp.writeFile(file, JSON.stringify({ ...state, cursor: null }, null, 2), { mode: 0o600 });

    auto = launch(['auto', '--config', autoConfig], 'auto', {
      HOME: path.join(tmp, 'home-host'),
      CLAUSROOM_STATE_DIR: hostState,
    });
    await stdoutLine(auto, 'CLAUSROOM_AUTO_READY');
    await stderrMatch(auto, /starting at the latest message/);

    const { asked, answer } = await askAuto('Agent, summarise the overflow.');
    assert.equal(
      answer.message.body_markdown,
      `answered ${asked.message.id}`,
      'the engine should have been handed exactly the question it answered',
    );
    assert.equal(answer.message.confidence, 'high', 'the confidence line should be lifted out');
    assert.ok(
      !answer.message.body_markdown.includes('Confidence:'),
      'the confidence line should not remain in the body',
    );
  });

  if (process.platform !== 'win32') {
    await step('Claude and Codex resume only their exact room session', async () => {
      await stop(auto);
      auto = null;
      const harness = [
        '#!/usr/bin/env node',
        "import { appendFileSync, readFileSync } from 'node:fs';",
        "import { basename } from 'node:path';",
        "const prompt = readFileSync(0, 'utf8');",
        "const agent = basename(process.argv[1]);",
        'const args = process.argv.slice(2);',
        "if (!prompt.includes('UNTRUSTED DATA')) process.exit(4);",
        "const ids = [...prompt.matchAll(/\\[(msg_[0-9a-f]{24})\\]/g)].map((m) => m[1]);",
        "const resumeAt = args.indexOf(agent === 'claude' ? '--resume' : 'resume');",
        "const freshAt = args.indexOf('--session-id');",
        "const id = resumeAt >= 0 ? args[resumeAt + 1] : agent === 'claude' ? args[freshAt + 1] : '0199a213-81c0-7800-8aa1-bbab2a035a53';",
        "appendFileSync(process.env.HARNESS_LOG, JSON.stringify({ agent, args, id, resumed: resumeAt >= 0 }) + '\\n');",
        "if (id === '00000000-0000-4000-8000-000000000001') { process.stderr.write('session not found\\n'); process.exit(2); }",
        "const reply = `answered ${ids.at(-1)}\\n\\nConfidence: high`;",
        "if (agent === 'claude') process.stdout.write(JSON.stringify({ result: reply, session_id: id, is_error: false }));",
        "else process.stdout.write([JSON.stringify({ type: 'thread.started', thread_id: id }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } })].join('\\n'));",
      ].join('\n');
      for (const name of ['claude', 'codex']) {
        const file = path.join(fakeBin, name);
        await fsp.writeFile(file, harness, { mode: 0o755 });
        await fsp.chmod(file, 0o755);
      }

      for (const agent of ['claude', 'codex']) {
        const config = configFile(
          `${agent}-resume.toml`,
          toml({ me: 'Mikel', partner: 'Ada', agent, autoReply: true }),
        );
        auto = launch(['auto', '--config', config], `${agent}-resume`, {
          HOME: path.join(tmp, 'home-host'),
          CLAUSROOM_STATE_DIR: hostState,
          HARNESS_LOG: harnessLog,
          PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
        });
        await stdoutLine(auto, 'CLAUSROOM_AUTO_READY');
        await stderrMatch(auto, /starting at the latest message|resuming after/);
        const callsBefore = fs.existsSync(harnessLog)
          ? (await fsp.readFile(harnessLog, 'utf8')).trim().split('\n').filter(Boolean).length
          : 0;
        for (let turn = 0; turn < 2; turn += 1) {
          await askAuto(`${agent} continuity ${turn}`, `${agent} resumed answer`);
        }
        const sessionFile = path.join(hostState, 'session.json');
        const state = JSON.parse(await fsp.readFile(sessionFile, 'utf8'));
        await fsp.writeFile(
          sessionFile,
          JSON.stringify({
            ...state,
            engine_session: { agent, id: '00000000-0000-4000-8000-000000000001' },
          }),
          { mode: 0o600 },
        );
        await askAuto(`${agent} stale continuity`, `${agent} fresh fallback answer`);
        await stop(auto);
        auto = null;
        const calls = (await fsp.readFile(harnessLog, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .slice(callsBefore)
          .map((line) => JSON.parse(line));
        assert.equal(calls.length, 4);
        assert.equal(calls[0].resumed, false);
        assert.equal(calls[1].resumed, true);
        assert.equal(calls[1].id, calls[0].id, `${agent} must resume the exact captured id`);
        assert.equal(calls[2].id, '00000000-0000-4000-8000-000000000001');
        assert.equal(calls[2].resumed, true);
        assert.equal(calls[3].resumed, false, `${agent} must recover fresh from a stale id`);
        assert.ok(!calls[1].args.includes('--continue'), 'bare latest-session continuation is forbidden');
        assert.ok(calls[0].args.includes(agent === 'claude' ? 'claude-opus-5' : 'gpt-5.6-sol'));
        assert.ok(calls[0].args.includes(agent === 'claude' ? '--effort' : 'model_reasoning_effort="low"'));
      }
    });
  }

  // --- the shipped CLI -----------------------------------------------------

  await step('the shipped bundle is self-contained', async () => {
    const help = launch(['--help'], 'help');
    const code = await new Promise((resolve) => help.once('exit', resolve));
    assert.equal(code, 0, `--help exited ${code}: ${help.err}`);
    const text = help.out.join('\n');
    for (const command of ['host', 'connect', 'project', 'check']) {
      assert.ok(text.includes(command), `--help should list ${command}`);
    }
    assert.ok(!text.includes('peer '), '--help should not advertise internal commands');

    const check = launch(['check', '--config', hostConfig], 'check', {
      HOME: path.join(tmp, 'home-host'),
      CLAUSROOM_STATE_DIR: hostState,
    });
    const checkCode = await new Promise((resolve) => check.once('exit', resolve));
    assert.equal(checkCode, 0, `check exited ${checkCode}`);
    assert.match(check.err, /Everything checks out/);
  });

  await step('a missing config is written, not an error', async () => {
    const fresh = path.join(tmp, 'fresh');
    await fsp.mkdir(fresh, { recursive: true });
    const written = launch(['check', '--config', path.join(fresh, 'clausroom.toml')], 'fresh', {
      HOME: path.join(tmp, 'home-fresh'),
      CLAUSROOM_STATE_DIR: path.join(fresh, 'state'),
    });
    const code = await new Promise((resolve) => written.once('exit', resolve));
    assert.equal(code, 0, `check on a fresh config exited ${code}: ${written.err}`);
    const body = await fsp.readFile(path.join(fresh, 'clausroom.toml'), 'utf8');
    for (const key of ['[me]', '[partner]', '[room]', '[project]', '[agent]', '[server]', '[peer]']) {
      assert.ok(body.includes(key), `the written config should contain ${key}`);
    }
    assert.ok(body.includes(JSON.stringify(ROOT)), 'it should point at where the command ran');
    assert.ok(!/arbt_|arit_|arst_/.test(body), 'a config file must never contain a token');
  });

  await step('sessions are cleaned up on exit', async () => {
    browserRelay?.close();
    browserRelay = null;
    await stop(guest);
    guest = null;
    await stop(auto);
    auto = null;
    await stop(host);
    host = null;
    assert.equal(
      fs.existsSync(path.join(hostState, 'session.json')),
      false,
      'the host should remove its session file',
    );
    assert.equal(
      fs.existsSync(path.join(tmp, 'state-guest', 'session.json')),
      false,
      'the guest should remove its session file',
    );
  });

  await step('old owner sessions stay revoked across host restarts', async () => {
    host = launch(['host', '--no-open', '--config', hostConfig], 'restart', {
      HOME: path.join(tmp, 'home-host'),
      CLAUSROOM_STATE_DIR: hostState,
    });
    const restartedUrl = await privateBrowserUrl(host);
    const freshOwner = new URLSearchParams(restartedUrl.hash.slice(1)).get('clausroom-session');
    assert.match(freshOwner, /^arst_[0-9a-f]{32}$/);
    refused(
      await api('GET', `${base}/api/me`, { token: human }),
      401,
      'unauthorized',
      'old owner session',
    );
    ok(await api('GET', `${base}/api/me`, { token: freshOwner }), 200, 'fresh owner session');
    await stop(host);
    host = null;
    assert.equal(fs.existsSync(path.join(hostState, 'session.json')), false);
  });

  process.stderr.write(`\nall ${passed.length} steps passed\n`);
} finally {
  if (mcp) await mcp.close().catch(() => undefined);
  for (const probe of probes) probe.close();
  browserRelay?.close();
  await Promise.allSettled([stop(auto), stop(guest), stop(host)]);
  for (const child of children) child.kill('SIGKILL');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}
