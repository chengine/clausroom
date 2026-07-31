#!/usr/bin/env node
/**
 * Integration test for `npm run up -- --peer`.
 *
 * Uses isolated app-specific DB/artifact/session paths, drives the launcher's
 * real offer/answer prompt, and verifies the joining peer's loopback URL.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SETUP = path.join(ROOT, 'scripts', 'host-setup.mjs');
const BRIDGE = path.join(ROOT, 'apps', 'bridge', 'dist', 'index.js');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clausroom-peer-up-'));
const children = new Set();

function lineBus(stream) {
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
          reject(new Error(`timed out waiting for ${prefix}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    close() {
      lines.close();
      for (const waiter of waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(`stream closed before ${waiter.prefix}`));
      }
    },
  };
}

function start(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('child did not stop after SIGINT')), 10_000),
    ),
  ]);
}

let host;
let join;
let hostLines;
let joinLines;
try {
  host = start(
    [
      HOST_SETUP,
      'up',
      '--peer',
      '--peer-no-stun',
      '--no-open',
      '--non-interactive',
      '--room-name',
      'peer launcher smoke',
    ],
    {
      AGENT_ROOM_HOST: '0.0.0.0',
      AGENT_ROOM_PORT: '0',
      AGENT_ROOM_DB: path.join(tempRoot, 'clausroom.sqlite'),
      AGENT_ROOM_ARTIFACT_DIR: path.join(tempRoot, 'artifacts'),
      CLAUSROOM_HOST_STATE_DIR: path.join(tempRoot, 'state'),
    },
  );
  hostLines = lineBus(host.stdout);
  const offer = await hostLines.wait('CLAUSROOM_PEER_OFFER');

  join = start([BRIDGE, 'peer', 'join', '--no-stun', '--listen-port', '0']);
  joinLines = lineBus(join.stdout);
  join.stdin.write(`${offer}\n`);
  const answer = await joinLines.wait('CLAUSROOM_PEER_ANSWER');
  host.stdin.write(`${answer}\n`);

  const [localUrl, hostPath, joinPath, upReady] = await Promise.all([
    joinLines.wait('CLAUSROOM_PEER_READY'),
    hostLines.wait('CLAUSROOM_PEER_PATH'),
    joinLines.wait('CLAUSROOM_PEER_PATH'),
    hostLines.wait('CLAUSROOM_UP_READY'),
  ]);
  assert.equal(upReady, 'peer-direct');
  assert.match(localUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(hostPath, /^direct /);
  assert.match(joinPath, /^direct /);

  const health = await fetch(`${localUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const headers = await new Promise((resolve, reject) => {
    http
      .get(`${localUrl}/`, (res) => {
        res.resume();
        res.once('end', () => resolve(res.headers));
      })
      .once('error', reject);
  });
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.match(headers['content-security-policy'] ?? '', /default-src 'self'/);

  process.stdout.write('peer launcher smoke test passed\n');
} finally {
  hostLines?.close();
  joinLines?.close();
  await Promise.allSettled([stop(host), stop(join)]);
  for (const child of children) child.kill('SIGKILL');
  await fs.rm(tempRoot, { recursive: true, force: true });
}
