#!/usr/bin/env node
/**
 * End-to-end test for the directory-independent command flow:
 *   (cd host-project && clausroom host)
 *   (cd guest-project && clausroom connect)
 *
 * It uses separate state directories for the two simulated users, disables
 * STUN for deterministic same-machine ICE, and verifies that the generated
 * project config contains one exact root and no credential. The guest enables
 * supervised Codex auto-response through a fake read-only engine executable.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'apps', 'bridge', 'dist-npm', 'cli.mjs');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clausroom-convenience-'));
const hostState = path.join(tempRoot, 'host-state');
const remoteHostState = path.join(tempRoot, 'remote-host-state');
const guestState = path.join(tempRoot, 'guest-state');
const hostSessionState = path.join(tempRoot, 'host-session');
const projectRoot = path.join(tempRoot, 'project');
const hostProjectRoot = path.join(tempRoot, 'host-project');
const guestHome = path.join(tempRoot, 'guest-home');
const fakeBin = path.join(tempRoot, 'fake-bin');
const children = new Set();

await fs.mkdir(projectRoot, { recursive: true });
await fs.mkdir(hostProjectRoot, { recursive: true });
await fs.mkdir(guestHome, { recursive: true });
await fs.mkdir(fakeBin, { recursive: true });
await fs.writeFile(
  path.join(fakeBin, 'codex'),
  `#!/usr/bin/env node
const args = process.argv.slice(2);
const execIndex = args.indexOf('exec');
if (execIndex === -1) process.exit(0);
if (
  args[execIndex - 2] !== '--ask-for-approval' ||
  args[execIndex - 1] !== 'never' ||
  !args.includes('--ignore-user-config') ||
  !args.includes('--ephemeral') ||
  !args.includes('read-only')
) {
  process.stderr.write('Codex auto invocation was not isolated and read-only\\n');
  process.exit(7);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  if (process.env.AGENT_ROOM_BRIDGE_TOKEN) {
    process.stderr.write('bridge token leaked into engine environment\\n');
    process.exit(9);
  }
  if (!prompt.includes('AUTOMATED_CONVENIENCE_QUESTION')) {
    process.stderr.write('expected question was absent from engine prompt\\n');
    process.exit(8);
  }
  process.stdout.write('Automated response from supervised Codex.\\nConfidence: high\\n');
});
`,
  { mode: 0o755 },
);

function lineBus(stream, label) {
  const values = [];
  const waiters = [];
  const lines = readline.createInterface({ input: stream });
  lines.on('line', (line) => {
    values.push(line);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!line.startsWith(`${waiter.prefix} `)) continue;
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(line.slice(waiter.prefix.length + 1));
    }
  });
  return {
    wait(prefix, timeoutMs = 45_000) {
      const existing = values.find((line) => line.startsWith(`${prefix} `));
      if (existing) return Promise.resolve(existing.slice(prefix.length + 1));
      return new Promise((resolve, reject) => {
        const waiter = { prefix, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`${label}: timed out waiting for ${prefix}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      lines.close();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`${label}: stream closed before ${waiter.prefix}`));
      }
    },
  };
}

function start(args, { cwd = ROOT, env = {} } = {}) {
  const child = spawn(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stderrLog = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    child.stderrLog += chunk;
    process.stderr.write(chunk.replace(/arst_[0-9a-f]{32}/g, '[session-redacted]'));
  });
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForStderr(child, pattern, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(child.stderrLog)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`process exited before stderr matched ${pattern}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for stderr to match ${pattern}`);
}

async function waitForAutoReply(localUrl, roomId, token, replyTo, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${localUrl}/api/rooms/${roomId}/messages?limit=100`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    const reply = body.messages.find(
      (message) =>
        message.reply_to_message_id === replyTo &&
        message.body_markdown === 'Automated response from supervised Codex.',
    );
    if (reply) return reply;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('timed out waiting for supervised auto-response');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert(address && typeof address !== 'string');
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

async function waitForFile(file, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForProjectConfig(stateDirectory, timeoutMs = 15_000) {
  const directory = path.join(stateDirectory, 'projects');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const files = await fs.readdir(directory);
      if (files.length === 1) return path.join(directory, files[0]);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for one project config in ${directory}`);
}

async function waitForExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs),
    ),
  ]);
}

async function stop(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGINT');
  try {
    await waitForExit(child, 15_000);
  } catch {
    child.kill('SIGKILL');
    await waitForExit(child, 5_000);
    throw new Error(`${label} did not stop cleanly after SIGINT`);
  }
}

function decodeOffer(code) {
  const prefix = 'clausroom-offer-v1.';
  assert.ok(code.startsWith(prefix));
  return JSON.parse(Buffer.from(code.slice(prefix.length), 'base64url').toString('utf8'));
}

let host;
let guest;
let hostLines;
let guestLines;
try {
  const serverPort = await freePort();
  host = start(
    [
      'host',
      '--repo',
      ROOT,
      '--skip-setup',
      '--no-stun',
      '--no-open',
      '--agent',
      'none',
      '--server-port',
      String(serverPort),
    ],
    {
      cwd: hostProjectRoot,
      env: {
        AGENT_ROOM_DB: path.join(tempRoot, 'clausroom.sqlite'),
        AGENT_ROOM_ARTIFACT_DIR: path.join(tempRoot, 'artifacts'),
        CLAUSROOM_HOST_STATE_DIR: hostSessionState,
        CLAUSROOM_HOST_ACTIVE_STATE_DIR: remoteHostState,
        CLAUSROOM_STATE_DIR: hostState,
      },
    },
  );
  hostLines = lineBus(host.stdout, 'host');
  const offer = await hostLines.wait('CLAUSROOM_PEER_OFFER');
  const decodedOffer = decodeOffer(offer);
  assert.match(decodedOffer.room.inviteToken, /^arit_[0-9a-f]{32}$/);
  assert.match(decodedOffer.room.bridgeToken, /^arbt_[0-9a-f]{32}$/);

  guest = start(['connect', '--no-stun', '--no-open', '--agent', 'codex', '--auto'], {
    cwd: projectRoot,
    env: {
      CLAUSROOM_STATE_DIR: guestState,
      HOME: guestHome,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
    },
  });
  guestLines = lineBus(guest.stdout, 'guest');
  guest.stdin.write(`CLAUSROOM_PEER_OFFER ${offer}\n`);
  const answer = await guestLines.wait('CLAUSROOM_PEER_ANSWER');
  host.stdin.write(`CLAUSROOM_PEER_ANSWER ${answer}\n`);

  const [localUrl] = await Promise.all([
    guestLines.wait('CLAUSROOM_PEER_READY'),
    hostLines.wait('CLAUSROOM_UP_READY'),
  ]);
  assert.match(localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  await Promise.all([
    waitForStderr(host, /Open this private browser URL \(do not share\):/),
    waitForStderr(guest, /Open this private browser URL \(do not share\):/),
  ]);
  assert.match(
    host.stderrLog,
    /Open this private browser URL \(do not share\): http:\/\/127\.0\.0\.1:\d+\/#clausroom-session=arst_[0-9a-f]{32}/,
  );
  assert.match(
    guest.stderrLog,
    /Open this private browser URL \(do not share\): http:\/\/127\.0\.0\.1:\d+\/#clausroom-session=arst_[0-9a-f]{32}/,
  );

  const hostActivePath = path.join(hostState, 'active-room.json');
  const remoteHostActivePath = path.join(remoteHostState, 'active-room.json');
  const guestActivePath = path.join(guestState, 'active-room.json');
  const hostActive = JSON.parse(await waitForFile(hostActivePath));
  const remoteHostActive = JSON.parse(await waitForFile(remoteHostActivePath));
  const guestActive = JSON.parse(await waitForFile(guestActivePath));
  assert.equal(hostActive.role, 'host');
  assert.equal(remoteHostActive.role, 'host');
  assert.equal(guestActive.role, 'guest');
  assert.equal(remoteHostActive.serverUrl, `http://127.0.0.1:${serverPort}`);
  assert.equal(guestActive.serverUrl, localUrl);
  assert.equal(guestActive.roomId, decodedOffer.room.roomId);
  assert.equal((await fs.stat(hostActivePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(remoteHostActivePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(guestActivePath)).mode & 0o777, 0o600);

  const health = await fetch(`${localUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  // The connect command exchanged the one-use invite for a browser session.
  const reusedInvite = await fetch(`${localUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite_token: decodedOffer.room.inviteToken }),
  });
  assert.equal(reusedInvite.status, 401);

  const guestConfigPath = await waitForProjectConfig(guestState);
  const config = await fs.readFile(guestConfigPath, 'utf8');
  assert.match(config, new RegExp(`roots = \\[${JSON.stringify(projectRoot).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]`));
  assert.match(config, /allow_agent_to_upload_files = false/);
  assert.match(config, /\[auto\]/);
  assert.match(config, /engine = "codex"/);
  assert.match(config, new RegExp(`workdir = ${JSON.stringify(projectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(config, /allowed_tools = \["Read", "Grep", "Glob"\]/);
  assert.match(config, /respond_to = "addressed"/);
  assert.doesNotMatch(config, /(?:arit|arbt|arst)_/);

  await waitForStderr(guest, /\[auto\] connected to room/);
  const questionResponse = await fetch(
    `${localUrl}/api/rooms/${decodedOffer.room.roomId}/messages`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${hostActive.bridgeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        recipient_ids: [],
        message_type: 'agent_question',
        body_markdown: 'AUTOMATED_CONVENIENCE_QUESTION',
      }),
    },
  );
  assert.equal(questionResponse.status, 201);
  const question = (await questionResponse.json()).message;
  const autoReply = await waitForAutoReply(
    localUrl,
    decodedOffer.room.roomId,
    hostActive.bridgeToken,
    question.id,
  );
  assert.equal(autoReply.confidence, 'high');

  const check = start(['check', '--config', guestConfigPath], {
    cwd: projectRoot,
    env: { AGENT_ROOM_BRIDGE_TOKEN: decodedOffer.room.bridgeToken },
  });
  const checkOutput = [];
  check.stdout.setEncoding('utf8');
  check.stdout.on('data', (chunk) => checkOutput.push(chunk));
  await waitForExit(check);
  assert.equal(check.exitCode, 0);
  assert.match(checkOutput.join(''), /All checks passed/);

  const localHostConfig = await fs.readFile(await waitForProjectConfig(hostState), 'utf8');
  assert.match(
    localHostConfig,
    new RegExp(JSON.stringify(hostProjectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.doesNotMatch(localHostConfig, /(?:arit|arbt|arst)_/);

  // Simulate `clausroom project` on the SSH target while host/browser control
  // remains in the outer process on the laptop.
  const hostProject = start(['project', '--agent', 'none'], {
    cwd: hostProjectRoot,
    env: { CLAUSROOM_STATE_DIR: remoteHostState },
  });
  await waitForExit(hostProject);
  assert.equal(hostProject.exitCode, 0);
  const hostProjectFiles = await fs.readdir(path.join(remoteHostState, 'projects'));
  assert.equal(hostProjectFiles.length, 1);
  const hostConfig = await fs.readFile(
    path.join(remoteHostState, 'projects', hostProjectFiles[0]),
    'utf8',
  );
  assert.match(hostConfig, new RegExp(JSON.stringify(hostProjectRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(hostConfig, /(?:arit|arbt|arst)_/);

  process.stdout.write('convenience command smoke test passed\n');
} finally {
  hostLines?.close();
  guestLines?.close();
  const shutdown = await Promise.allSettled([stop(host, 'host'), stop(guest, 'connect')]);
  for (const child of children) child.kill('SIGKILL');
  const failure = shutdown.find((result) => result.status === 'rejected');
  if (!failure) {
    await assert.rejects(fs.access(path.join(hostState, 'active-room.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(remoteHostState, 'active-room.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(guestState, 'active-room.json')), { code: 'ENOENT' });
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (failure?.status === 'rejected') throw failure.reason;
}
