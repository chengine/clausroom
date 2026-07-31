#!/usr/bin/env node
/**
 * End-to-end smoke test for direct WebRTC peer mode.
 *
 * Starts a loopback HTTP target, manually shuttles the generated offer/answer
 * between two real bridge subprocesses, and verifies small and multi-megabyte
 * requests through the joining peer's loopback proxy. STUN is disabled so the
 * test is deterministic and makes no network requests.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Exercise the exact bundle shipped by npm, including its external optional
// node-datachannel resolution.
const BRIDGE = path.join(ROOT, 'apps', 'bridge', 'dist-npm', 'cli.mjs');
const LARGE_BODY = Buffer.alloc(2 * 1024 * 1024, 0x63);
const ECHO_BODY = Buffer.alloc(1024 * 1024, 0x71);
const ICE_ARGS = process.env.CLAUSROOM_PEER_SMOKE_USE_STUN === '1' ? [] : ['--no-stun'];
const children = new Set();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function startPeer(args, name) {
  const child = spawn(process.execPath, [BRIDGE, ...args], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.stderrLog = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    child.stderrLog += chunk;
    process.stderr.write(`[${name}] ${chunk}`);
  });
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForStderr(child, pattern, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(child.stderrLog)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`peer exited before stderr matched ${pattern}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for stderr to match ${pattern}`);
}

function waitForLine(child, prefix, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const lines = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      lines.close();
      reject(new Error(`timed out waiting for ${prefix}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timer);
      lines.close();
      reject(new Error(`peer exited before ${prefix} (code=${code}, signal=${signal})`));
    };
    child.once('exit', onExit);
    lines.on('line', (line) => {
      if (!line.startsWith(`${prefix} `)) return;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      lines.close();
      resolve(line.slice(prefix.length + 1));
    });
  });
}

async function stopPeer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGINT');
  await Promise.race([
    exited,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('peer did not stop after SIGINT')), 10_000),
    ),
  ]);
}

const target = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.setHeader('content-type', 'application/json');
    res.end('{"ok":true}');
    return;
  }
  if (req.url === '/large') {
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(LARGE_BODY.byteLength));
    res.end(LARGE_BODY);
    return;
  }
  if (req.url === '/echo' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-length', String(body.byteLength));
      res.end(body);
    });
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});

let host;
let join;
try {
  const address = await listen(target);
  assert(address && typeof address !== 'string');

  host = startPeer(
    ['peer', 'host', '--target', `http://127.0.0.1:${address.port}`, ...ICE_ARGS],
    'host',
  );
  const offer = await waitForLine(host, 'CLAUSROOM_PEER_OFFER');
  await waitForStderr(host, /gathered ICE candidates: .*host\/TCP=[1-9]\d*/);

  join = startPeer(['peer', 'join', ...ICE_ARGS, '--listen-port', '0'], 'join');
  const answerPromise = waitForLine(join, 'CLAUSROOM_PEER_ANSWER');
  join.stdin.write('not-a-clausroom-offer\n');
  await waitForStderr(join, /still running; paste the correct offer code and try again/);
  assert.equal(join.exitCode, null);
  join.stdin.write(`${offer}\n`);
  const answer = await answerPromise;
  await waitForStderr(join, /gathered ICE candidates: .*host\/TCP=[1-9]\d*/);

  const hostReadyPromise = waitForLine(host, 'CLAUSROOM_PEER_READY');
  const joinReadyPromise = waitForLine(join, 'CLAUSROOM_PEER_READY');
  host.stdin.write('not-a-clausroom-answer\n');
  await waitForStderr(host, /still running; paste the correct answer code and try again/);
  assert.equal(host.exitCode, null);
  host.stdin.write(`${answer}\n`);
  const [hostTarget, localUrl] = await Promise.all([hostReadyPromise, joinReadyPromise]);
  assert.equal(hostTarget, `http://127.0.0.1:${address.port}`);

  const health = await fetch(`${localUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });

  const echo = await fetch(`${localUrl}/echo`, { method: 'POST', body: ECHO_BODY });
  assert.equal(echo.status, 200);
  assert.deepEqual(Buffer.from(await echo.arrayBuffer()), ECHO_BODY);

  const large = await fetch(`${localUrl}/large`);
  assert.equal(large.status, 200);
  assert.deepEqual(Buffer.from(await large.arrayBuffer()), LARGE_BODY);

  process.stdout.write('peer smoke test passed\n');
} finally {
  await Promise.allSettled([
    host ? stopPeer(host) : Promise.resolve(),
    join ? stopPeer(join) : Promise.resolve(),
  ]);
  for (const child of children) child.kill('SIGKILL');
  await close(target);
}
