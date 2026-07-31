#!/usr/bin/env node
/**
 * End-to-end test for the directory-independent command flow:
 *   clausroom host -> clausroom connect -> clausroom project
 *
 * It uses separate state directories for the two simulated users, disables
 * STUN for deterministic same-machine ICE, and verifies that the generated
 * project config contains one exact root and no credential.
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
const guestState = path.join(tempRoot, 'guest-state');
const hostSessionState = path.join(tempRoot, 'host-session');
const projectRoot = path.join(tempRoot, 'project');
const children = new Set();

await fs.mkdir(projectRoot, { recursive: true });

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
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  child.once('exit', () => children.delete(child));
  return child;
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
      '--server-port',
      String(serverPort),
    ],
    {
      cwd: tempRoot,
      env: {
        AGENT_ROOM_DB: path.join(tempRoot, 'clausroom.sqlite'),
        AGENT_ROOM_ARTIFACT_DIR: path.join(tempRoot, 'artifacts'),
        CLAUSROOM_HOST_STATE_DIR: hostSessionState,
        CLAUSROOM_STATE_DIR: hostState,
      },
    },
  );
  hostLines = lineBus(host.stdout, 'host');
  const offer = await hostLines.wait('CLAUSROOM_PEER_OFFER');
  const decodedOffer = decodeOffer(offer);
  assert.match(decodedOffer.room.inviteToken, /^arit_[0-9a-f]{32}$/);
  assert.match(decodedOffer.room.bridgeToken, /^arbt_[0-9a-f]{32}$/);

  guest = start(['connect', '--no-stun', '--no-open'], {
    cwd: tempRoot,
    env: { CLAUSROOM_STATE_DIR: guestState },
  });
  guestLines = lineBus(guest.stdout, 'guest');
  guest.stdin.write(`${offer}\n`);
  const answer = await guestLines.wait('CLAUSROOM_PEER_ANSWER');
  host.stdin.write(`${answer}\n`);

  const [localUrl] = await Promise.all([
    guestLines.wait('CLAUSROOM_PEER_READY'),
    hostLines.wait('CLAUSROOM_UP_READY'),
  ]);
  assert.match(localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);

  const hostActivePath = path.join(hostState, 'active-room.json');
  const guestActivePath = path.join(guestState, 'active-room.json');
  const hostActive = JSON.parse(await waitForFile(hostActivePath));
  const guestActive = JSON.parse(await waitForFile(guestActivePath));
  assert.equal(hostActive.role, 'host');
  assert.equal(guestActive.role, 'guest');
  assert.equal(guestActive.serverUrl, localUrl);
  assert.equal(guestActive.roomId, decodedOffer.room.roomId);
  assert.equal((await fs.stat(hostActivePath)).mode & 0o777, 0o600);
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

  const project = start(['project', '--agent', 'none'], {
    cwd: projectRoot,
    env: { CLAUSROOM_STATE_DIR: guestState },
  });
  const projectOutput = [];
  project.stdout.setEncoding('utf8');
  project.stdout.on('data', (chunk) => projectOutput.push(chunk));
  await waitForExit(project);
  assert.equal(project.exitCode, 0);
  assert.match(projectOutput.join(''), /Filesystem access is limited/);

  const projectFiles = await fs.readdir(path.join(guestState, 'projects'));
  assert.equal(projectFiles.length, 1);
  const config = await fs.readFile(path.join(guestState, 'projects', projectFiles[0]), 'utf8');
  assert.match(config, new RegExp(`roots = \\[${JSON.stringify(projectRoot).replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\]`));
  assert.match(config, /allow_agent_to_upload_files = false/);
  assert.doesNotMatch(config, /(?:arit|arbt|arst)_/);

  const check = start(['check', '--config', path.join(guestState, 'projects', projectFiles[0])], {
    cwd: projectRoot,
    env: { AGENT_ROOM_BRIDGE_TOKEN: decodedOffer.room.bridgeToken },
  });
  const checkOutput = [];
  check.stdout.setEncoding('utf8');
  check.stdout.on('data', (chunk) => checkOutput.push(chunk));
  await waitForExit(check);
  assert.equal(check.exitCode, 0);
  assert.match(checkOutput.join(''), /All checks passed/);

  process.stdout.write('convenience command smoke test passed\n');
} finally {
  hostLines?.close();
  guestLines?.close();
  const shutdown = await Promise.allSettled([stop(host, 'host'), stop(guest, 'connect')]);
  for (const child of children) child.kill('SIGKILL');
  const failure = shutdown.find((result) => result.status === 'rejected');
  if (!failure) {
    await assert.rejects(fs.access(path.join(hostState, 'active-room.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(guestState, 'active-room.json')), { code: 'ENOENT' });
  }
  await fs.rm(tempRoot, { recursive: true, force: true });
  if (failure?.status === 'rejected') throw failure.reason;
}
