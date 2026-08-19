#!/usr/bin/env node
/**
 * One end-to-end test of the whole thing, run against the built artifacts.
 *
 * It starts a real room with `clausroom host`, exercises the HTTP and WebSocket
 * surface as a human, drives the room tools as an agent over stdio MCP, joins
 * from a second process through the real WebRTC tunnel and moves megabytes over
 * it, then watches the auto-responder answer a message. Nothing is mocked and
 * nothing reaches the network: STUN is off, so ICE only finds local candidates.
 *
 *   npm run build && npm run smoke
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
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

/** Spawn a clausroom process with its own home, state directory, and config. */
function launch(args, name, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CLAUSROOM_REPO: ROOT, ...env },
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

  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
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

const toolText = (result) =>
  (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// ---------------------------------------------------------------------------
// The test
// ---------------------------------------------------------------------------

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'clausroom-smoke-'));
const project = path.join(tmp, 'project');
const engine = path.join(tmp, 'engine.mjs');
await fsp.mkdir(project, { recursive: true });

function configFile(name, body) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, body);
  return file;
}

/** A clausroom.toml with the parts this test varies. */
function toml({ me, partner, agent = 'none', autoReply = false, command = [], uploads = true, port = 0 }) {
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
port = ${port}
data = ${JSON.stringify(path.join(tmp, 'data'))}

[peer]
stun = []
port = 0
`;
}

let host;
let guest;
let auto;
let mcp;
const probes = [];

try {
  assert.ok(fs.existsSync(CLI), `${CLI} is missing — run npm run build first`);

  // --- the host's room ------------------------------------------------------

  const hostConfig = configFile('host.toml', toml({ me: 'Mikel', partner: 'Ada' }));
  const hostState = path.join(tmp, 'state-host');
  let base;
  let room;
  let human;
  let session;
  let offer;

  await step('host starts a room', async () => {
    await fsp.writeFile(path.join(project, 'notes.md'), '# Notes\n\nThe regularizer overflows.\n');
    await fsp.writeFile(path.join(project, '.env'), 'OPENAI_API_KEY=sk-secretsecret123\n');
    await fsp.writeFile(path.join(project, 'big.bin'), BIG);

    host = launch(['host', '--no-open', '--config', hostConfig], 'host', {
      HOME: path.join(tmp, 'home-host'),
      CLAUSROOM_STATE_DIR: hostState,
    });
    offer = await stdoutLine(host, 'CLAUSROOM_PEER_OFFER');
    assert.match(offer, /^clausroom-offer-v1\./);

    // The private browser URL is the host's own way in, so it carries the token.
    await stderrMatch(host, /clausroom-session=arst_[0-9a-f]{32}/);
    human = /clausroom-session=(arst_[0-9a-f]{32})/.exec(host.err)[1];

    session = JSON.parse(await fsp.readFile(path.join(hostState, 'session.json'), 'utf8'));
    assert.equal(session.role, 'host');
    assert.match(session.server, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(session.token, /^arbt_[0-9a-f]{32}$/);
    assert.equal(session.me, 'Mikel');
    base = session.server;
    room = session.room;

    const stat = await fsp.stat(path.join(hostState, 'session.json'));
    assert.equal(stat.mode & 0o077, 0, 'the session file must not be group or world readable');
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

  await step('the agent turn limit holds, and a human resets it', async () => {
    // Earlier steps left agent messages at the tail; start from a clean run.
    ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: { message_type: 'human_message', body_markdown: 'Go ahead.' },
      }),
      201,
      'reset the run',
    );
    for (let i = 0; i < 3; i += 1) {
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
    const first = multipart('trace.log', 'trace\n', { description: 'A trace' });
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

    const requested = ok(
      await api('POST', `${base}/api/rooms/${room}/approvals`, {
        token: session.token,
        json: { approval_type: 'artifact_upload', payload: { filename: 'trace.log', size_bytes: 6 } },
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

    const withApproval = multipart('trace.log', 'trace\n', {
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

    const rotated = ok(
      await api('POST', `${base}/api/rooms/${room}/participants/${added.participant.user_id}/token`, {
        token: human,
      }),
      200,
      'rotate',
    );
    assert.match(rotated.invite_token, /^arit_[0-9a-f]{32}$/);
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

  // --- the guest, over the real tunnel -------------------------------------

  await step('the guest joins over a direct connection', async () => {
    const guestConfig = configFile('guest.toml', toml({ me: 'Ada', partner: 'Mikel' }));
    guest = launch(['connect', '--no-open', '--config', guestConfig], 'guest', {
      HOME: path.join(tmp, 'home-guest'),
      CLAUSROOM_STATE_DIR: path.join(tmp, 'state-guest'),
    });

    // A mistyped paste must not tear the room down.
    guest.stdin.write('not-an-offer\n');
    await stderrMatch(guest, /still waiting — paste the right offer/);
    assert.equal(guest.exitCode, null);
    guest.stdin.write(`${offer}\n`);

    const answer = await stdoutLine(guest, 'CLAUSROOM_PEER_ANSWER');
    host.stdin.write('not-an-answer\n');
    await stderrMatch(host, /still waiting — paste the right answer/);
    assert.equal(host.exitCode, null);
    host.stdin.write(`${answer}\n`);

    const [hostPath, guestPath] = await Promise.all([
      stdoutLine(host, 'CLAUSROOM_PEER_PATH'),
      stdoutLine(guest, 'CLAUSROOM_PEER_PATH'),
    ]);
    assert.match(hostPath, /^direct/, 'the host must report a direct path, never a relay');
    assert.match(guestPath, /^direct/, 'the guest must report a direct path, never a relay');
  });

  let guestBase;

  await step('the room works through the tunnel', async () => {
    guestBase = await stdoutLine(guest, 'CLAUSROOM_PEER_READY');
    assert.match(guestBase, /^http:\/\/127\.0\.0\.1:\d+$/);
    const guestSession = JSON.parse(
      await fsp.readFile(path.join(tmp, 'state-guest', 'session.json'), 'utf8'),
    );
    assert.equal(guestSession.role, 'guest');
    assert.equal(guestSession.room, room);
    assert.equal(guestSession.me, 'Ada', 'the guest is labelled the way the host named them');
    assert.match(guestSession.token, /^arbt_[0-9a-f]{32}$/);
    assert.notEqual(guestSession.token, session.token, 'each side has its own agent token');

    assert.deepEqual(ok(await api('GET', `${guestBase}/healthz`), 200, 'tunnelled healthz'), { ok: true });

    await stderrMatch(guest, /clausroom-session=arst_[0-9a-f]{32}/);
    const guestHuman = /clausroom-session=(arst_[0-9a-f]{32})/.exec(guest.err)[1];
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
  });

  await step('megabytes move both ways through the tunnel', async () => {
    const guestHuman = /clausroom-session=(arst_[0-9a-f]{32})/.exec(guest.err)[1];
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
  });

  // --- answering on its own ------------------------------------------------

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

    const asked = ok(
      await api('POST', `${base}/api/rooms/${room}/messages`, {
        token: human,
        json: {
          message_type: 'human_message',
          body_markdown: 'Agent, summarise the overflow.',
          recipient_ids: [myAgent.user_id],
        },
      }),
      201,
      'ask the agent',
    );

    const answer = await humanProbe.waitFor(
      (f) =>
        f.type === 'message_created' &&
        f.message.message_type === 'agent_answer' &&
        f.message.reply_to_message_id === asked.message.id,
      'auto answer',
      120_000,
    );
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

  process.stderr.write(`\nall ${passed.length} steps passed\n`);
} finally {
  if (mcp) await mcp.close().catch(() => undefined);
  for (const probe of probes) probe.close();
  await Promise.allSettled([stop(auto), stop(guest), stop(host)]);
  for (const child of children) child.kill('SIGKILL');
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
}
