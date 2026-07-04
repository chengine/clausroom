#!/usr/bin/env node
/**
 * clausroom HOST setup wizard.
 *
 * Removes the manual token-shuffling from spinning up a room. It:
 *   1. ensures a clausroom server is running (probes an existing one, or spawns
 *      the built server with --start and parses CLAUSROOM_LISTENING / the
 *      bootstrap invite from its stdout);
 *   2. prints the exact `tailscale serve` command the operator runs elsewhere
 *      (the wizard never runs tailscale itself);
 *   3. logs in with the bootstrap/provided invite, creates a room, and adds the
 *      three participants over REST (teacher human -> arit_ invite, the
 *      student's agent -> arbt_ bridge token, the teacher's agent -> arbt_
 *      bridge token) using the exact server contract the smoke test uses;
 *   4. emits copy-paste artifacts to stdout: the student's own bridge.toml +
 *      `claude mcp add` + `export` lines, and a filled-in teacher onboarding
 *      message with the room URL, invite token, bridge token, and room id;
 *   5. optionally writes ~/.clausroom/bridge.toml for the student (never a
 *      secret — the token lives in an env var only).
 *
 * Dependency-free: only Node built-ins (node:http/https/readline/...). Fully
 * scriptable via flags/env for non-interactive use; never crashes on a missing
 * TTY. Human chatter and prompts go to stderr; the copy-paste artifacts go to
 * stdout so the output stays parseable.
 *
 *   Interactive (host machine, server already running via `npm start`):
 *     npm run host -- --invite arit_<bootstrap token>
 *
 *   Have the wizard start a throwaway server too:
 *     npm run host -- --start
 *
 *   Fully non-interactive (CI / scripting):
 *     CLAUSROOM_HOST_INVITE=arit_... npm run host -- \
 *       --non-interactive --room-name "Debug Room" \
 *       --room-url https://clausroom-host.your-tailnet.ts.net
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import * as rlPromises from 'node:readline/promises';
import { fileURLToPath, URL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js');

const DEFAULT_TARGET = 'http://127.0.0.1:3000';
const DEFAULT_CONFIG_PATH = '~/.clausroom/bridge.toml';
const DEFAULT_REPO_URL = 'https://github.com/chengine/clausroom';
const ROOM_URL_PLACEHOLDER = 'https://clausroom-host.YOUR-TAILNET.ts.net';
const PROJECT_PLACEHOLDER = '/path/to/your/project';

// Boolean flags never consume the following argv token.
const BOOL_FLAGS = new Set([
  'start',
  'write-student-config',
  'non-interactive',
  'yes',
  'no-serve',
  'no-open',
  'help',
  'h',
]);

const HOST_SESSION_FILE = () => path.join(os.homedir(), '.clausroom', 'host-session.json');
const TAILSCALE_ADMIN_URL = 'https://login.tailscale.com/admin/machines';
const TAILSCALE_DNS_URL = 'https://login.tailscale.com/admin/dns';

// WSL -> Windows: the Windows Tailscale CLI is callable from WSL at this path, and
// (in NAT mode with localhost forwarding) exposing `localhost:<port>` via the
// Windows exe reaches a WSL server bound to 0.0.0.0.
const WINDOWS_TAILSCALE_EXE = '/mnt/c/Program Files/Tailscale/tailscale.exe';

// tailscale serve HANGS (never returns) when the tailnet has HTTPS certs disabled;
// it first prints this to stdout/stderr. We watch for it and fall back instead of
// hanging. (The `tailscale cert` path 500s with the same class of error.)
const TS_CERTS_DISABLED_RE = /does not support getting TLS certs/i;

// ---------------------------------------------------------------------------
// tiny utilities
// ---------------------------------------------------------------------------

class WizardError extends Error {}

/** Human chatter + progress -> stderr (keeps stdout artifacts clean). */
function info(msg) {
  process.stderr.write(`${msg}\n`);
}

/** Copy-paste artifacts -> stdout. */
function out(msg) {
  process.stdout.write(`${msg}\n`);
}

function fail(msg) {
  throw new WizardError(msg);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isEnvTrue(value) {
  if (value === undefined) return false;
  const v = String(value).trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Quote for a TOML basic string (JSON escaping is a strict subset). */
function tomlStr(value) {
  return JSON.stringify(String(value));
}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      if (BOOL_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i += 1;
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = a.slice(1);
      flags[key] = true;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// ---------------------------------------------------------------------------
// HTTP (node:http / node:https, no dependencies)
// ---------------------------------------------------------------------------

function request(method, urlStr, { token, json, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error(`invalid URL: ${urlStr}`));
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {};
    let payload;
    if (token) headers.authorization = `Bearer ${token}`;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const req = lib.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          data = text;
        }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms: ${method} ${urlStr}`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function describeError(res) {
  if (res.data && res.data.error && res.data.error.code) {
    return `${res.data.error.code}: ${res.data.error.message}`;
  }
  return typeof res.data === 'string' ? res.data.slice(0, 300) : JSON.stringify(res.data).slice(0, 300);
}

function expectStatus(res, want, label) {
  if (res.status !== want) {
    fail(`${label}: expected HTTP ${want}, got ${res.status} — ${describeError(res)}`);
  }
  return res;
}

async function probeHealth(baseUrl) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await request('GET', `${baseUrl}/healthz`, { timeoutMs: 5000 });
      if (res.status === 200 && res.data && res.data.ok === true) return true;
    } catch {
      /* retry */
    }
    if (attempt < 3) await sleep(500);
  }
  return false;
}

/** Is this session token still good against this server? (GET /api/me -> 200). */
async function validateSession(baseUrl, sessionToken) {
  try {
    const res = await request('GET', `${baseUrl}/api/me`, { token: sessionToken, timeoutMs: 5000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// saved host session (~/.clausroom/host-session.json) — session token only
// ---------------------------------------------------------------------------

function hostSessionPath() {
  return HOST_SESSION_FILE();
}

/** Read {server?, session_token} or null. Never throws. */
async function readHostSession() {
  try {
    const raw = await fsp.readFile(hostSessionPath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.session_token === 'string' && data.session_token.startsWith('arst_')) {
      return data;
    }
  } catch {
    /* missing/corrupt — treat as none */
  }
  return null;
}

/** Persist the host session (0600, no other secrets). */
async function writeHostSession({ server, session_token }) {
  const p = hostSessionPath();
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const body = JSON.stringify({ server, session_token }, null, 2) + '\n';
  await fsp.writeFile(p, body, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// server lifecycle (only used with --start)
// ---------------------------------------------------------------------------

let serverProc = null;
let startedServer = false;
let cleanupRegistered = false;
let upMode = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const onSignal = (signal) => {
    info(`\n[host-setup] received ${signal}, stopping the server...`);
    stopServerSync();
    if (upMode) {
      info('[host-setup] server stopped; run `npm run up` again to resume. ' +
        '(Left the persistent `tailscale serve --bg` config in place.)');
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('exit', () => stopServerSync());
}

/** Best-effort synchronous kill for the exit/signal path. */
function stopServerSync() {
  if (!startedServer || !serverProc) return;
  if (serverProc.exitCode !== null || serverProc.signalCode !== null) return;
  try {
    serverProc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

/** Graceful async stop: SIGTERM, wait, then SIGKILL. */
async function stopServer() {
  if (!startedServer || !serverProc) return;
  if (serverProc.exitCode !== null || serverProc.signalCode !== null) return;
  const exited = new Promise((resolve) => serverProc.once('exit', resolve));
  try {
    serverProc.kill('SIGTERM');
  } catch {
    return;
  }
  const raced = await Promise.race([exited, sleep(5000).then(() => 'timeout')]);
  if (raced === 'timeout') {
    try {
      serverProc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    await Promise.race([exited, sleep(2000)]);
  }
}

/**
 * Spawn the built server with the current environment, capture its stdout, and
 * resolve once CLAUSROOM_LISTENING appears (supports AGENT_ROOM_PORT=0). Also
 * captures CLAUSROOM_BOOTSTRAP_INVITE / CLAUSROOM_RECOVERY_INVITE if printed.
 */
async function startServer() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    fail(`server not built: ${SERVER_ENTRY} missing. Run 'npm run build' first.`);
  }
  info('[host-setup] starting the server: node apps/server/dist/index.js');
  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc = proc;
  startedServer = true;
  proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

  const rl = readline.createInterface({ input: proc.stdout });
  const result = { port: null, invite: null, recovery: null };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('timed out after 15s waiting for CLAUSROOM_LISTENING from the server')),
      15_000,
    );
    rl.on('line', (line) => {
      process.stderr.write(`[server] ${line}\n`);
      let m;
      if ((m = line.match(/^CLAUSROOM_BOOTSTRAP_INVITE (arit_[0-9a-f]{32})$/))) result.invite = m[1];
      else if ((m = line.match(/^CLAUSROOM_RECOVERY_INVITE (arit_[0-9a-f]{32})$/))) result.recovery = m[1];
      else if ((m = line.match(/^CLAUSROOM_LISTENING (\d+)$/))) {
        result.port = Number(m[1]);
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code} before it started listening`));
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return result;
}

/** The loopback URL this process should use to reach a server on `port`. */
function loopbackBaseUrl(port) {
  const hostEnv = process.env.AGENT_ROOM_HOST;
  const connectHost =
    !hostEnv || hostEnv === '0.0.0.0' || hostEnv === '::' || hostEnv === '[::]' ? '127.0.0.1' : hostEnv;
  return `http://${connectHost}:${port}`;
}

// ---------------------------------------------------------------------------
// tailscale + browser (best-effort child processes; never abort the flow)
// ---------------------------------------------------------------------------

/** Run a child, capture stdout/stderr. Never throws; ENOENT -> {ok:false}. */
function runCmd(cmd, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      done({ ok: false, code: -1, stdout, stderr: `${stderr}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    proc.stdout.on('data', (d) => {
      stdout += d;
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, code: -1, stdout, stderr: String(err) });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/** Quote a command path for display in a copy-pasteable shell line. */
function shellQuoteCmd(cmd) {
  return /[\s"']/.test(cmd) ? `"${cmd}"` : cmd;
}

/**
 * Probe one tailscale CLI candidate. Returns null when the binary is absent at
 * this path (ENOENT); otherwise reports whether the backend is Running and the
 * self DNS name (trailing dot stripped) even if we could not parse status.
 */
async function probeTailscaleCli(cmd) {
  const res = await runCmd(cmd, ['status', '--json']);
  const notFound = !res.ok && res.code === -1 && /ENOENT|not found|no such file/i.test(res.stderr || '');
  if (notFound) return null; // binary absent at this path
  let status = null;
  try {
    status = JSON.parse(res.stdout);
  } catch {
    /* CLI present but not logged in / not running yet */
  }
  const backendRunning = Boolean(status && status.BackendState === 'Running');
  const rawName = status && status.Self && status.Self.DNSName ? String(status.Self.DNSName) : '';
  const dnsName = rawName ? rawName.replace(/\.+$/, '') : null; // strip trailing dot(s)
  return { backendRunning, dnsName };
}

/**
 * Locate a usable tailscale CLI and inspect it. Search order (per onboarding v2):
 *   (a) `tailscale` on PATH (native linux/mac),
 *   (b) the Windows exe at its known WSL path, then `tailscale.exe` on PATH.
 * Among the candidates that exist, prefer one whose backend is Running with a DNS
 * name; otherwise return the first that exists. `windows` marks a Windows-side CLI
 * driven from WSL (which needs the server bound to 0.0.0.0 to be reachable).
 */
async function detectTailscale() {
  const candidates = [
    { cmd: 'tailscale', windows: false },
    { cmd: WINDOWS_TAILSCALE_EXE, windows: true },
    { cmd: 'tailscale.exe', windows: true },
  ];
  const found = [];
  for (const cand of candidates) {
    const info = await probeTailscaleCli(cand.cmd);
    if (info) found.push({ available: true, cmd: cand.cmd, windows: cand.windows, ...info });
  }
  if (found.length === 0) {
    return { available: false, cmd: null, windows: false, backendRunning: false, dnsName: null };
  }
  return found.find((f) => f.backendRunning && f.dnsName) || found[0];
}

/**
 * Background a persistent reverse proxy: `<cmd> serve --bg --https=443
 * localhost:<port>`. Returns quickly on success (--bg backgrounds and exits). If
 * the tailnet has HTTPS certs disabled the command HANGS instead of erroring, so
 * we stream its output, detect the certs-disabled message, and kill it early
 * ({ certsDisabled:true }) rather than blocking. A hard timeout is the last resort.
 */
function tailscaleServe(cmd, port) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, ['serve', '--bg', '--https=443', `localhost:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: -1, stdout: '', stderr: String(err), certsDisabled: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        proc.kill('SIGKILL'); // no-op if it already backgrounded & exited
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    const certsDisabled = () => TS_CERTS_DISABLED_RE.test(stderr) || TS_CERTS_DISABLED_RE.test(stdout);
    const checkCerts = () => {
      if (certsDisabled()) finish({ ok: false, code: -1, stdout, stderr, certsDisabled: true });
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        code: -1,
        stdout,
        stderr: `${stderr}\n[timed out after 25000ms — 'serve' did not return; HTTPS certs may be disabled]`,
        certsDisabled: certsDisabled(),
        timedOut: true,
      });
    }, 25_000);
    proc.stdout.on('data', (d) => {
      stdout += d;
      checkCerts();
    });
    proc.stderr.on('data', (d) => {
      stderr += d;
      checkCerts();
    });
    proc.on('error', (err) => finish({ ok: false, code: -1, stdout, stderr: String(err), certsDisabled: false }));
    proc.on('close', (code) => finish({ ok: code === 0, code, stdout, stderr, certsDisabled: certsDisabled() }));
  });
}

/** Best-effort open a URL in the default browser. Any failure is a silent no-op. */
async function openBrowser(url) {
  const attempts = [
    ['wslview', [url]],
    ['explorer.exe', [url]],
    ['xdg-open', [url]],
    ['open', [url]],
    ['cmd.exe', ['/c', 'start', '', url]],
  ];
  for (const [cmd, args] of attempts) {
    const ok = await new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(cmd, args, { stdio: 'ignore', detached: true });
      } catch {
        resolve(false);
        return;
      }
      proc.on('error', () => resolve(false));
      proc.on('spawn', () => {
        try {
          proc.unref();
        } catch {
          /* ignore */
        }
        resolve(true);
      });
    });
    if (ok) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// artifact builders
// ---------------------------------------------------------------------------

function studentBridgeToml({ humanName, agentName, serverUrl, roomId, tokenEnv, projectRoot, roomUrlHint }) {
  const roots = `[${tomlStr(projectRoot)}]`;
  const lines = [
    '# clausroom bridge config — STUDENT / HOST side (generated by scripts/host-setup.mjs).',
    `# The bridge token is NEVER stored here: export it as ${tokenEnv}.`,
    '',
    '[identity]',
    `human_name  = ${tomlStr(humanName)}`,
    `agent_name  = ${tomlStr(agentName)}`,
    'bridge_name = "student-dev-bridge"',
    '',
    '[room]',
    `# Your bridge runs on the same machine as the server, so loopback works.`,
    roomUrlHint ? `# (Or use your Tailscale Serve URL: ${roomUrlHint})` : '# (Or use your Tailscale Serve URL once exposed.)',
    `server_url = ${tomlStr(serverUrl)}`,
    `room_id    = ${tomlStr(roomId)}`,
    `token_env  = ${tomlStr(tokenEnv)}`,
    '',
    '[policy]',
    'read_only_default                  = true',
    'allow_agent_to_send_text           = true',
    'allow_agent_to_upload_files        = false',
    'require_human_approval_for_uploads = true',
    'max_upload_bytes_without_approval  = 1048576',
    'max_upload_bytes_absolute          = 104857600',
    '',
    '[filesystem]',
    `# Point at the project you are asking about — never your home directory.`,
    `roots         = ${roots}`,
    'deny_globs    = []',
    'downloads_dir = "~/.clausroom/downloads"',
    '',
  ];
  return lines.join('\n');
}

function mcpAddLine(tokenEnv, configPath) {
  return [
    'claude mcp add --transport stdio clausroom \\',
    `  --env ${tokenEnv}=$${tokenEnv} \\`,
    `  -- npx -y clausroom-bridge mcp --config ${configPath}`,
  ].join('\n');
}

function teacherOnboarding({
  teacherName,
  studentName,
  projectName,
  roomUrl,
  inviteToken,
  bridgeToken,
  roomId,
  repoUrl,
  tokenEnv,
  configPath,
}) {
  const healthz = `${roomUrl.replace(/\/$/, '')}/healthz`;
  return [
    '========================================================================',
    'TEACHER ONBOARDING MESSAGE  —  copy-paste and send over a channel you trust',
    '========================================================================',
    '',
    `Room URL:            ${roomUrl}`,
    `Room id:             ${roomId}`,
    `Invite token:        ${inviteToken}   (arit_, single-use, browser login)`,
    `Agent bridge token:  ${bridgeToken}   (arbt_, room-scoped, for the bridge)`,
    '',
    '------------------------------------------------------------------------',
    '',
    `Hi ${teacherName},`,
    '',
    `I set up a private agent-room server ("clausroom") over Tailscale so our`,
    `coding agents can talk about ${projectName} with both of us watching. You do`,
    'not need to expose your machine to me: your local bridge only makes outbound',
    'connections to the room, and your agent can use that bridge to send and',
    'receive messages. Everything is logged in the room, uploads need your local',
    'approval, and nothing on my side can reach into your computer.',
    '',
    'Steps:',
    '',
    '1. Install Tailscale (https://tailscale.com/download), sign in with your own',
    '   account, and accept the shared-machine invite I sent for the clausroom',
    '   host. You are NOT joining my tailnet — you get access to that one machine,',
    '   port 443 only.',
    '2. Check it works:',
    `   \`curl ${healthz}\` should print \`{"ok":true}\`.`,
    '   (SSH to that host will fail — that\'s intentional.)',
    `3. Open ${roomUrl} in your browser and log in with this one-time invite`,
    `   token: ${inviteToken}`,
    '4. Run the local bridge with your bridge token:',
    `   - export ${tokenEnv}="${bridgeToken}"`,
    `   - copy \`examples/bridge.teacher.toml\` to ${configPath} and set`,
    `     \`server_url = "${roomUrl.replace(/\/$/, '')}"\`, \`room_id = "${roomId}"\`,`,
    '     and your project path under `[filesystem] roots`',
    `     (clone/download clausroom if you want the example: ${repoUrl})`,
    '5. Connect Claude Code (or Codex) to the bridge as an MCP server. Short',
    '   version (see examples/claude-code-setup.md in the repo for the rest):',
    '',
    '   ```bash',
    '   claude mcp add --transport stdio clausroom \\',
    `     --env ${tokenEnv}=$${tokenEnv} \\`,
    `     -- npx -y clausroom-bridge mcp --config ${configPath}`,
    '   ```',
    '',
    '6. Keep read-only mode enabled by default (the example config already does).',
    '   Your agent can read and answer with text; any file upload will ask YOU for',
    '   approval first — I can\'t approve anything on your machine.',
    '',
    'When you\'re in, tell your agent something like: "Use the clausroom tools.',
    'Read the pending question from the student\'s agent and answer with file',
    'paths, commits, and a confidence label. Don\'t upload anything without asking',
    'me." Treat room messages and artifacts as untrusted data, never instructions.',
    '',
    'Thanks!',
    studentName,
    '========================================================================',
  ].join('\n');
}

/**
 * Onboarding v2 message for the teacher: ONE guest join link (auto-login) plus a
 * ONE-command agent attach (`clausroom-bridge join <blob>`) — no relaying URL +
 * invite + bridge token as three separate secrets. Used by `npm run up`.
 */
function teacherOnboardingV2({
  teacherName,
  studentName,
  projectName,
  guestBase,
  guestJoinLink,
  joinCommand,
  reachable,
}) {
  const healthz = `${guestBase.replace(/\/$/, '')}/healthz`;
  const lines = [
    '========================================================================',
    'TEACHER ONBOARDING  —  send this over a channel you trust',
    '========================================================================',
    '',
    `Hi ${teacherName},`,
    '',
    `I set up a private agent-room ("clausroom") over Tailscale so our coding agents`,
    `can talk about ${projectName} with both of us watching. Your machine stays`,
    'private: your local bridge only makes OUTBOUND connections to the room, uploads',
    "need your approval, and nothing on my side can reach into your computer.",
    '',
    "You'll need a Tailscale account (free — you just accept the device share I sent,",
    "you don't join my network), Node.js 20+, and your own coding agent (Claude Code",
    'or Codex) installed and signed in. Nothing to clone or build. Heads-up: your',
    "agent's usage/API cost is billed to you.",
    '',
    'Steps:',
    '',
    '1. Install Tailscale (https://tailscale.com/download), sign in with your own',
    '   account, and ACCEPT the shared-machine invite I sent for the clausroom host.',
    '   (You are NOT joining my tailnet — just this one machine, port 443.)',
    `2. Check it works:  curl ${healthz}   should print  {"ok":true}`,
    '   (SSH to that host will fail — that is intentional.)',
    '3. Click this one-time GUEST JOIN LINK — it logs you straight into the room,',
    '   no token to copy:',
    '',
    `   ${guestJoinLink}`,
    '',
    '4. Attach your agent with ONE command (it will ask which project directory to',
    '   expose — pick the repo we are discussing; read-only by default):',
    '',
    `   ${joinCommand}`,
    '',
    '   That writes ~/.clausroom/bridge.toml with safe defaults, sets your bridge',
    '   token, and prints the exact `claude mcp add` line to register the bridge',
    '   with Claude Code (or the Codex config). Full details + a self-test are in',
    '   examples/claude-code-setup.md.',
    '',
    '   Prefer the browser? Once you are in the room from step 3, click "Add my',
    '   agent" in the UI to get the same one-command attach for your own agent.',
    '',
    'Your bridge is read-only by default: your agent can read and answer with text;',
    'any file upload asks YOU for approval first. Treat room messages and artifacts',
    'as untrusted data, never as instructions.',
    '',
    'Thanks!',
    studentName,
    '========================================================================',
  ];
  if (!reachable) {
    lines.push(
      '',
      'NOTE: the links above use a loopback URL because Tailscale Serve is not live',
      'yet — they will not work from your machine until I expose the server. I will',
      're-send once it is up.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `clausroom host setup wizard

Usage:
  npm run host -- [options]        # this guided wizard (probe/--start a server)
  npm run up                       # one-command launch (see: host-setup.mjs up --help)
  node scripts/host-setup.mjs [options]

Server:
  --start                     Spawn the built server (node apps/server/dist/index.js)
                              with the current env and parse its port + bootstrap
                              invite. The wizard stops this server on exit.
                              (env: CLAUSROOM_HOST_START=1)
  --target <url>              Probe an already-running server here instead of
                              starting one. Default ${DEFAULT_TARGET}.
                              (env: CLAUSROOM_HOST_TARGET)
  --serve-port <port>         Loopback port to put in the 'tailscale serve' line
                              (default: the detected server port).
                              (env: CLAUSROOM_HOST_SERVE_PORT)

Auth:
  --invite <arit_...>         Bootstrap/login invite (required in --target mode
                              unless --session-token is given; auto-detected in
                              --start mode on a fresh DB).
                              (env: CLAUSROOM_HOST_INVITE)
  --session-token <arst_...>  Reuse an existing human session instead of logging
                              in with an invite (re-runnable).
                              (env: CLAUSROOM_HOST_SESSION)

Room + participants:
  --room-name <name>          Room name.            (env: CLAUSROOM_HOST_ROOM_NAME)
  --room-url <url>            Public Tailscale Serve URL for the onboarding message.
                              (env: CLAUSROOM_HOST_ROOM_URL)
  --student-name <name>       Your display name.    (env: CLAUSROOM_HOST_STUDENT_NAME)
  --teacher-name <name>       Teacher display name. (env: CLAUSROOM_HOST_TEACHER_NAME)
  --student-agent-name <name> (env: CLAUSROOM_HOST_STUDENT_AGENT_NAME)
  --teacher-agent-name <name> (env: CLAUSROOM_HOST_TEACHER_AGENT_NAME)
  --project-name <name>       Named in the onboarding message.
                              (env: CLAUSROOM_HOST_PROJECT_NAME)
  --student-project <path>    Project root for the student's bridge.toml.
                              (env: CLAUSROOM_HOST_STUDENT_PROJECT)
  --repo-url <url>            (env: CLAUSROOM_HOST_REPO_URL)

Output:
  --write-student-config      Offer to write the student's bridge.toml (no token).
                              (env: CLAUSROOM_HOST_WRITE_STUDENT_CONFIG=1)
  --config-path <path>        Where to write it. Default ${DEFAULT_CONFIG_PATH}.
                              (env: CLAUSROOM_HOST_CONFIG_PATH)
  --token-env <name>          Env var name for the bridge token in snippets.
                              Default AGENT_ROOM_BRIDGE_TOKEN.

Behavior:
  --non-interactive           Never prompt; require values via flags/env.
  --yes                       Don't prompt; accept defaults / confirm writes.
  --help                      Show this help.

Subcommands:
  up                          One-command host launch (start server + tailscale
                              serve + create room + emit onboarding + stay up).
                              See: node scripts/host-setup.mjs up --help
`;

const UP_HELP = `clausroom — npm run up (one-command host launch)

Starts the built server, exposes it via Tailscale Serve, creates a room and its
three participants, and prints ready-to-send links, then stays up streaming
server logs until you press Ctrl-C. Onboarding v2 removes the manual key exchange:

  * Tailscale auto-detected on PATH, at the Windows exe path, or as tailscale.exe
    (WSL -> Windows). When a Windows-side CLI drives the proxy, the server is bound
    to 0.0.0.0 so the localhost relay reaches it.
  * If your tailnet has HTTPS certs disabled, 'serve' would hang — it's detected,
    you're told the exact one-time enable step, and it falls back to loopback.
  * Prints a localhost MAGIC-LOGIN link (auto-logs YOU in) and opens it.
  * Prints ONE guest join link (auto-login) plus the teacher's ONE-command agent
    attach ('npx -y clausroom-bridge join <blob>') — no relaying three secrets.

Usage:
  npm run up
  node scripts/host-setup.mjs up [options]

Options:
  --no-serve                  Don't run 'tailscale serve'; use a loopback URL and
                              print the command to run yourself.
  --no-open                   Don't try to open the magic-login link in a browser.
  --non-interactive           Never prompt; take names from flags/env or defaults.
  --invite <arit_...>         Login invite to use when no saved session is valid.
                              Normally auto-detected from the server's bootstrap/
                              recovery output. (env: CLAUSROOM_HOST_INVITE)
  --room-name <name>          (env: CLAUSROOM_HOST_ROOM_NAME)  default "clausroom debug room"
  --teacher-name <name>       (env: CLAUSROOM_HOST_TEACHER_NAME)  default "Teacher"
  --student-name <name>       (env: CLAUSROOM_HOST_STUDENT_NAME)  default "Student"
  --student-agent-name <name> (env: CLAUSROOM_HOST_STUDENT_AGENT_NAME)
  --teacher-agent-name <name> (env: CLAUSROOM_HOST_TEACHER_AGENT_NAME)
  --project-name <name>       (env: CLAUSROOM_HOST_PROJECT_NAME)
  --student-project <path>    Project root for your bridge.toml.
                              (env: CLAUSROOM_HOST_STUDENT_PROJECT)
  --config-path <path>        Bridge config path shown in snippets. Default ${DEFAULT_CONFIG_PATH}.
  --token-env <name>          Env var name for the bridge token. Default AGENT_ROOM_BRIDGE_TOKEN.
  --repo-url <url>            (env: CLAUSROOM_HOST_REPO_URL)
  --help                      Show this help.

Session reuse: a validated host session is cached at ~/.clausroom/host-session.json
(mode 0600, session token only) and reused on the next 'npm run up'.

Server env (AGENT_ROOM_*): AGENT_ROOM_PORT (0 = ephemeral), AGENT_ROOM_DB,
AGENT_ROOM_ARTIFACT_DIR, AGENT_ROOM_HOST — identical to 'npm start'.

Readiness sentinel: prints 'CLAUSROOM_UP_READY <url>' on stdout once the room is
live and every artifact has been emitted.
`;

/** flagOrEnv + ask helpers bound to a parsed flag set + interactive rl. */
function makeHelpers(flags, interactive, rl) {
  const flagOrEnv = (flagKey, envKey) => {
    if (flags[flagKey] !== undefined && flags[flagKey] !== true) return String(flags[flagKey]);
    const v = envKey ? process.env[envKey] : undefined;
    return v !== undefined && v !== '' ? v : undefined;
  };

  async function ask(flagKey, envKey, { prompt, def, required } = {}) {
    let v = flagOrEnv(flagKey, envKey);
    if ((v === undefined || v === '') && interactive && rl) {
      const suffix = def !== undefined && def !== '' ? ` [${def}]` : '';
      const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
      v = answer || def;
    } else if (v === undefined || v === '') {
      v = def;
    }
    if ((v === undefined || v === '') && required) {
      fail(`missing required value for --${flagKey}${envKey ? ` (or ${envKey})` : ''}: ${prompt}`);
    }
    return v;
  }

  return { flagOrEnv, ask };
}

/**
 * Create a room and its three participants (teacher human -> arit_, student's
 * agent -> arbt_, teacher's agent owned by the teacher -> arbt_) over REST.
 * Shared by the wizard and by `up`.
 */
async function createRoomWithParticipants(baseUrl, sessionToken, names) {
  const { roomName, teacherName, studentAgentName, teacherAgentName } = names;

  info(`[host-setup] creating room "${roomName}"...`);
  const roomRes = expectStatus(
    await request('POST', `${baseUrl}/api/rooms`, { token: sessionToken, json: { name: roomName } }),
    201,
    'create room',
  );
  const room = roomRes.data.room;
  info(`[host-setup] room created: ${room.id}`);

  info('[host-setup] adding the teacher (human)...');
  const teacherRes = expectStatus(
    await request('POST', `${baseUrl}/api/rooms/${room.id}/participants`, {
      token: sessionToken,
      json: { display_name: teacherName, kind: 'human', role: 'human' },
    }),
    201,
    'add teacher',
  );
  const teacherInvite = teacherRes.data.invite_token;
  const teacherUserId = teacherRes.data.participant.user_id;
  if (!teacherInvite || !teacherInvite.startsWith('arit_')) {
    fail(`teacher invite token missing/malformed: ${JSON.stringify(teacherRes.data).slice(0, 200)}`);
  }

  info("[host-setup] adding the student's agent (owned by you)...");
  const studentAgentRes = expectStatus(
    await request('POST', `${baseUrl}/api/rooms/${room.id}/participants`, {
      token: sessionToken,
      json: { display_name: studentAgentName, kind: 'agent', role: 'agent' },
    }),
    201,
    'add student agent',
  );
  const studentBridgeToken = studentAgentRes.data.bridge_token;
  if (!studentBridgeToken || !studentBridgeToken.startsWith('arbt_')) {
    fail(`student bridge token missing/malformed: ${JSON.stringify(studentAgentRes.data).slice(0, 200)}`);
  }

  info("[host-setup] adding the teacher's agent (owned by the teacher)...");
  const teacherAgentRes = expectStatus(
    await request('POST', `${baseUrl}/api/rooms/${room.id}/participants`, {
      token: sessionToken,
      json: {
        display_name: teacherAgentName,
        kind: 'agent',
        role: 'agent',
        owner_user_id: teacherUserId,
      },
    }),
    201,
    'add teacher agent',
  );
  const teacherBridgeToken = teacherAgentRes.data.bridge_token;
  if (!teacherBridgeToken || !teacherBridgeToken.startsWith('arbt_')) {
    fail(`teacher bridge token missing/malformed: ${JSON.stringify(teacherAgentRes.data).slice(0, 200)}`);
  }

  return { room, teacherInvite, teacherUserId, studentBridgeToken, teacherBridgeToken };
}

/**
 * `npm run up` — the one-command host launch. Reuses startServer / auth /
 * createRoomWithParticipants / the artifact builders, adds tailscale serve,
 * browser open, session caching, a readiness sentinel, and a foreground stay-up.
 */
async function runUp(flags) {
  upMode = true;
  const interactive = Boolean(process.stdin.isTTY) && !flags['non-interactive'];
  const rl = interactive
    ? rlPromises.createInterface({ input: process.stdin, output: process.stderr })
    : null;
  const { flagOrEnv, ask } = makeHelpers(flags, interactive, rl);

  const tokenEnv = flagOrEnv('token-env') || 'AGENT_ROOM_BRIDGE_TOKEN';
  const configPath = flagOrEnv('config-path', 'CLAUSROOM_HOST_CONFIG_PATH') || DEFAULT_CONFIG_PATH;
  const noServe = Boolean(flags['no-serve']);
  const noOpen = Boolean(flags['no-open']);

  info('clausroom — npm run up');
  info('======================');

  try {
    // --- 1/2. detect tailscale FIRST (so we can bind the server correctly) --
    // Do this before spawning the server: when a Windows-side Tailscale drives the
    // proxy from WSL, `localhost:<port>` only reaches the WSL server if it binds
    // 0.0.0.0 (NAT + localhost forwarding). We set AGENT_ROOM_HOST accordingly
    // before startServer, which copies process.env into the child.
    let ts = { available: false, cmd: null, windows: false, backendRunning: false, dnsName: null };
    if (!noServe) {
      info('[host-setup] looking for the Tailscale CLI...');
      ts = await detectTailscale();
      if (ts.available && ts.windows && ts.backendRunning) {
        const host = process.env.AGENT_ROOM_HOST;
        if (!host || host === '127.0.0.1' || host === 'localhost') {
          process.env.AGENT_ROOM_HOST = '0.0.0.0';
          info(
            '[host-setup] WSL + Windows Tailscale detected; binding the server to ' +
              '0.0.0.0 so the Windows localhost relay reaches it.',
          );
        }
      }
    }

    // --- start the server (foreground for the life of the command) -------
    registerCleanup();
    const started = await startServer(); // fails clearly if dist missing / times out
    const serverPort = started.port;
    const baseUrl = loopbackBaseUrl(serverPort);
    info(`[host-setup] server is listening on ${baseUrl}`);

    // --- 3. authenticate: reuse saved session, else exchange an invite ---
    let sessionToken = null;
    const saved = await readHostSession();
    if (saved && (await validateSession(baseUrl, saved.session_token))) {
      sessionToken = saved.session_token;
      info(`[host-setup] reusing your saved host session (${hostSessionPath()}).`);
    }
    if (!sessionToken) {
      const invite = flagOrEnv('invite', 'CLAUSROOM_HOST_INVITE') || started.invite || started.recovery;
      if (!invite) {
        fail(
          'no valid saved session and the server printed no bootstrap/recovery invite. ' +
            'If this room existed before, your saved session likely expired — restart the ' +
            'server to mint a CLAUSROOM_RECOVERY_INVITE (printed on startup), or re-run ' +
            'with --invite arit_....',
        );
      }
      info('[host-setup] logging in with the invite token...');
      const login = expectStatus(
        await request('POST', `${baseUrl}/api/auth/login`, { json: { invite_token: invite } }),
        200,
        'login',
      );
      sessionToken = login.data.session_token;
      if (typeof sessionToken !== 'string' || !sessionToken.startsWith('arst_')) {
        fail(`login returned no valid session token: ${JSON.stringify(login.data).slice(0, 200)}`);
      }
      await writeHostSession({ server: baseUrl, session_token: sessionToken });
      info(
        `[host-setup] logged in as ${login.data.user.display_name}; saved session to ` +
          `${hostSessionPath()} (mode 0600).`,
      );
    }

    // --- 4. tailscale serve (unless --no-serve); degrade gracefully ------
    const loopbackUrl = `http://127.0.0.1:${serverPort}/`;
    const manualServeLine = `${shellQuoteCmd(ts.cmd || 'tailscale')} serve --bg --https=443 localhost:${serverPort}`;
    let roomUrl; // the URL the operator sees (public when served, else loopback)
    let publicBaseUrl = null; // set only when tailscale serve is actually live
    let servedPublicly = false;
    if (noServe) {
      info('[host-setup] --no-serve: not touching tailscale; using a loopback URL.');
      info('[host-setup] Expose it yourself when ready:');
      info(`[host-setup]     ${manualServeLine}`);
      roomUrl = loopbackUrl;
    } else if (ts.available && ts.backendRunning && ts.dnsName) {
      info(`[host-setup] tailscale is up (${shellQuoteCmd(ts.cmd)}); exposing localhost:${serverPort} on :443...`);
      const res = await tailscaleServe(ts.cmd, serverPort);
      if (res.ok) {
        publicBaseUrl = `https://${ts.dnsName}`;
        roomUrl = `${publicBaseUrl}/`;
        servedPublicly = true;
        info(`[host-setup] tailscale serve is live: ${roomUrl}`);
      } else if (res.certsDisabled) {
        info('[host-setup] WARNING: your tailnet has HTTPS certificates DISABLED, so');
        info("[host-setup] 'tailscale serve --https=443' cannot get a TLS cert (it would hang).");
        info('[host-setup] ENABLE it once (takes ~10 s), then re-run `npm run up`:');
        info(`[host-setup]     1. Open ${TAILSCALE_DNS_URL}`);
        info('[host-setup]     2. Under "HTTPS Certificates", click Enable.');
        info('[host-setup] Falling back to a loopback URL for now.');
        roomUrl = loopbackUrl;
      } else {
        info(
          `[host-setup] WARNING: 'tailscale serve' did not succeed (exit ${res.code}): ` +
            `${(res.stderr || '').trim().slice(0, 200)}`,
        );
        info('[host-setup] falling back to a loopback URL. Run this yourself when ready:');
        info(`[host-setup]     ${manualServeLine}`);
        roomUrl = loopbackUrl;
      }
    } else {
      const why = !ts.available
        ? 'tailscale CLI not found (looked for `tailscale`, the Windows exe, and `tailscale.exe`)'
        : !ts.backendRunning
          ? 'tailscale is installed but not logged in / not running'
          : "could not read this machine's Tailscale DNS name";
      info(`[host-setup] WARNING: ${why}; skipping automatic exposure.`);
      info('[host-setup] falling back to a loopback URL. Run this yourself once tailscale is ready:');
      info(`[host-setup]     ${manualServeLine}`);
      roomUrl = loopbackUrl;
    }

    // --- 5. room name + participant display names ------------------------
    const roomName = await ask('room-name', 'CLAUSROOM_HOST_ROOM_NAME', {
      prompt: 'Room name',
      def: 'clausroom debug room',
      required: true,
    });
    const studentName = await ask('student-name', 'CLAUSROOM_HOST_STUDENT_NAME', {
      prompt: 'Your (student) display name',
      def: 'Student',
    });
    const teacherName = await ask('teacher-name', 'CLAUSROOM_HOST_TEACHER_NAME', {
      prompt: 'Teacher display name',
      def: 'Teacher',
    });
    const studentAgentName = await ask('student-agent-name', 'CLAUSROOM_HOST_STUDENT_AGENT_NAME', {
      prompt: 'Your agent display name',
      def: `${studentName}'s Agent`,
    });
    const teacherAgentName = await ask('teacher-agent-name', 'CLAUSROOM_HOST_TEACHER_AGENT_NAME', {
      prompt: 'Teacher agent display name',
      def: `${teacherName}'s Agent`,
    });
    const projectName = await ask('project-name', 'CLAUSROOM_HOST_PROJECT_NAME', {
      prompt: 'Project name (for the onboarding message)',
      def: 'our project',
    });
    const repoUrl = flagOrEnv('repo-url', 'CLAUSROOM_HOST_REPO_URL') || DEFAULT_REPO_URL;
    const studentProject =
      flagOrEnv('student-project', 'CLAUSROOM_HOST_STUDENT_PROJECT') || PROJECT_PLACEHOLDER;

    const { room, teacherInvite, teacherBridgeToken, studentBridgeToken } =
      await createRoomWithParticipants(baseUrl, sessionToken, {
        roomName,
        teacherName,
        studentAgentName,
        teacherAgentName,
      });

    if (rl) rl.close();

    // --- 6. build links + the one-command guest attach -------------------
    // Magic host login: a localhost-only link that logs YOU in (no token hunting).
    const magicLoginUrl = `http://127.0.0.1:${serverPort}/join#s=${sessionToken}`;

    // The base URL the teacher will actually reach: the public Tailscale URL when
    // serve is live, else loopback (won't work for them until exposed — flagged).
    const guestBase = (publicBaseUrl || `http://127.0.0.1:${serverPort}`).replace(/\/+$/, '');
    const guestJoinLink = `${guestBase}/join#i=${teacherInvite}`;

    // The teacher's agent attaches with ONE command; the blob carries connection
    // info + the teacher's OWN bridge token only (never local config — §13). Encode
    // ONLY via @clausroom/protocol; dynamic import keeps --help working unbuilt.
    const { encodeJoinBlob } = await import('@clausroom/protocol');
    const teacherJoinBlob = encodeJoinBlob({
      v: 1,
      server_url: guestBase,
      room_id: room.id,
      token: teacherBridgeToken,
      agent_name: teacherAgentName,
    });
    const teacherJoinCommand = `npx -y clausroom-bridge join ${teacherJoinBlob}`;

    // --- emit artifacts to stdout ---------------------------------------
    const studentServerUrl = `http://127.0.0.1:${serverPort}`;
    const bridgeToml = studentBridgeToml({
      humanName: studentName,
      agentName: studentAgentName,
      serverUrl: studentServerUrl,
      roomId: room.id,
      tokenEnv,
      projectRoot: studentProject,
      roomUrlHint: servedPublicly ? roomUrl : null,
    });

    out('');
    out('########################################################################');
    out('# clausroom is UP');
    out('########################################################################');
    out('');
    out(`Room URL: ${roomUrl}`);
    out('');
    out('# YOU (host) — click this magic link to log in automatically (localhost only):');
    out(magicLoginUrl);
    out('');
    out('########################################################################');
    out('# SEND THE TEACHER ONE LINK  (no more relaying URL + invite + token by hand)');
    out('########################################################################');
    out('');
    out('# Guest join link (auto-login — single-use, treat as a secret):');
    out(guestJoinLink);
    out('');
    out("# The teacher's agent attaches with this ONE command (writes bridge.toml with");
    out('# safe local defaults; the teacher picks their own project directory):');
    out(teacherJoinCommand);
    out('');
    out(
      teacherOnboardingV2({
        teacherName,
        studentName,
        projectName,
        guestBase,
        guestJoinLink,
        joinCommand: teacherJoinCommand,
        reachable: servedPublicly,
      }),
    );
    out('');
    out('########################################################################');
    out('# STUDENT (you) — your own bridge.toml, token, and attach line');
    out('########################################################################');
    out('');
    out(`# 1. Save this as ${configPath} (edit [filesystem] roots to your project):`);
    out('# ----- begin bridge.toml -----');
    out(bridgeToml);
    out('# ----- end bridge.toml -----');
    out('');
    out('# 2. Export your bridge token (shown ONCE — keep it safe):');
    out(`export ${tokenEnv}="${studentBridgeToken}"`);
    out('');
    out('# 3. Register the bridge with Claude Code:');
    out(mcpAddLine(tokenEnv, configPath));
    out('');
    out('########################################################################');
    out('# ONE REMAINING MANUAL STEP — share the host with the teacher');
    out('#   (Tailscale has NO CLI for device sharing; do this in the admin console)');
    out('########################################################################');
    out('');
    out(`#  1. Open the Tailscale admin console:  ${TAILSCALE_ADMIN_URL}`);
    out('#  2. Find the clausroom host machine, open its "..." menu -> Share...,');
    out('#     then Copy share link and send that link to the teacher.');
    out('#  3. Open the ACL editor (Access Controls) and paste');
    out('#     deploy/tailscale-policy.hujson so the guest reaches ONLY tcp:443');
    out('#     on this one machine.');
    out('');

    // --- reminders (stderr) ---------------------------------------------
    info('');
    info('[host-setup] REMINDER: every token/link above is shown exactly ONCE — the');
    info('[host-setup] server stores only SHA-256 hashes. Copy them now.');
    if (!servedPublicly && !noServe) {
      info('[host-setup] NOTE: tailscale serve did not run, so the URLs above are');
      info('[host-setup]       loopback-only — the guest link/command will not reach the');
      info(`[host-setup]       teacher until you expose it:  ${manualServeLine}`);
      info('[host-setup]       Re-run `npm run up` afterwards to reprint working links.');
    }

    // --- 7. open the browser to the MAGIC LOGIN link (auto-login) --------
    if (!noOpen) {
      const opened = await openBrowser(magicLoginUrl);
      if (opened) info('[host-setup] opened the magic-login link in your browser (auto-logged in).');
    }

    // --- 8. readiness sentinel, then stay up in the foreground ----------
    out(`CLAUSROOM_UP_READY ${roomUrl}`);
    info('[host-setup] room is live. Leave this running; press Ctrl-C to stop the server.');

    await new Promise((resolve) => {
      if (!serverProc || serverProc.exitCode !== null || serverProc.signalCode !== null) {
        resolve();
        return;
      }
      serverProc.once('exit', (code) => {
        info(`[host-setup] server exited (code ${code}); shutting down.`);
        process.exitCode = code && code !== 0 ? 1 : 0;
        resolve();
      });
    });
  } finally {
    if (rl) rl.close();
  }
}

async function runWizard(flags) {
  const assumeYes = Boolean(flags.yes);
  const interactive = Boolean(process.stdin.isTTY) && !flags['non-interactive'] && !assumeYes;
  const rl = interactive
    ? rlPromises.createInterface({ input: process.stdin, output: process.stderr })
    : null;

  const { flagOrEnv, ask } = makeHelpers(flags, interactive, rl);

  const tokenEnv = flagOrEnv('token-env') || 'AGENT_ROOM_BRIDGE_TOKEN';
  const configPath = flagOrEnv('config-path', 'CLAUSROOM_HOST_CONFIG_PATH') || DEFAULT_CONFIG_PATH;

  try {
    info('clausroom host setup wizard');
    info('===========================');

    // --- 1. ensure a server is running -----------------------------------
    const start = Boolean(flags.start) || isEnvTrue(process.env.CLAUSROOM_HOST_START);
    let baseUrl;
    let serverPort;
    let invite = flagOrEnv('invite', 'CLAUSROOM_HOST_INVITE');
    const sessionTokenFlag = flagOrEnv('session-token', 'CLAUSROOM_HOST_SESSION');

    if (start) {
      registerCleanup();
      const started = await startServer();
      serverPort = started.port;
      baseUrl = loopbackBaseUrl(serverPort);
      if (!invite && !sessionTokenFlag) invite = started.invite || started.recovery;
      if (!invite && !sessionTokenFlag) {
        fail(
          'the server started but printed no bootstrap/recovery invite (its DB is ' +
            'already initialized). Pass --invite arit_... / CLAUSROOM_HOST_INVITE, or ' +
            '--session-token arst_....',
        );
      }
      info(`[host-setup] server is listening on ${baseUrl}`);
    } else {
      const target = (flagOrEnv('target', 'CLAUSROOM_HOST_TARGET') || DEFAULT_TARGET).replace(/\/+$/, '');
      baseUrl = target;
      info(`[host-setup] probing ${baseUrl}/healthz ...`);
      const ok = await probeHealth(baseUrl);
      if (!ok) {
        fail(
          `no clausroom server reachable at ${baseUrl}/healthz. Start it first ` +
            `('npm start', it prints CLAUSROOM_BOOTSTRAP_INVITE + CLAUSROOM_LISTENING) ` +
            `and re-run with --invite, or pass --start to have this wizard launch one.`,
        );
      }
      const u = new URL(baseUrl);
      serverPort = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      if (!invite && !sessionTokenFlag) {
        fail(
          'a login credential is required: pass --invite arit_... (the server prints ' +
            'CLAUSROOM_BOOTSTRAP_INVITE on first run) or --session-token arst_....',
        );
      }
      info('[host-setup] server is reachable.');
    }

    const servePort = flagOrEnv('serve-port', 'CLAUSROOM_HOST_SERVE_PORT') || String(serverPort);

    // --- 2. tailscale exposure command -----------------------------------
    const serveCmd = `tailscale serve --https=443 localhost:${servePort}`;

    // --- 3. login + create room + participants ---------------------------
    let sessionToken;
    if (sessionTokenFlag) {
      sessionToken = sessionTokenFlag;
      info('[host-setup] using the provided session token (skipping invite login).');
    } else {
      info('[host-setup] logging in with the invite token...');
      const login = expectStatus(
        await request('POST', `${baseUrl}/api/auth/login`, { json: { invite_token: invite } }),
        200,
        'login',
      );
      sessionToken = login.data.session_token;
      if (typeof sessionToken !== 'string' || !sessionToken.startsWith('arst_')) {
        fail(`login returned no valid session token: ${JSON.stringify(login.data).slice(0, 200)}`);
      }
      info(`[host-setup] logged in as ${login.data.user.display_name} (${login.data.user.id}).`);
    }

    const roomName = await ask('room-name', 'CLAUSROOM_HOST_ROOM_NAME', {
      prompt: 'Room name',
      def: 'clausroom debug room',
      required: true,
    });
    const studentName = await ask('student-name', 'CLAUSROOM_HOST_STUDENT_NAME', {
      prompt: 'Your (student) display name',
      def: 'Student',
    });
    const teacherName = await ask('teacher-name', 'CLAUSROOM_HOST_TEACHER_NAME', {
      prompt: 'Teacher display name',
      def: 'Teacher',
    });
    const studentAgentName = await ask('student-agent-name', 'CLAUSROOM_HOST_STUDENT_AGENT_NAME', {
      prompt: 'Your agent display name',
      def: `${studentName}'s Agent`,
    });
    const teacherAgentName = await ask('teacher-agent-name', 'CLAUSROOM_HOST_TEACHER_AGENT_NAME', {
      prompt: 'Teacher agent display name',
      def: `${teacherName}'s Agent`,
    });
    const projectName = await ask('project-name', 'CLAUSROOM_HOST_PROJECT_NAME', {
      prompt: 'Project name (for the onboarding message)',
      def: 'our project',
    });
    const roomUrlRaw = await ask('room-url', 'CLAUSROOM_HOST_ROOM_URL', {
      prompt: 'Public room URL (Tailscale Serve)',
      def: ROOM_URL_PLACEHOLDER,
    });
    const roomUrl = roomUrlRaw.replace(/\/+$/, '');
    const repoUrl = flagOrEnv('repo-url', 'CLAUSROOM_HOST_REPO_URL') || DEFAULT_REPO_URL;
    const studentProject =
      flagOrEnv('student-project', 'CLAUSROOM_HOST_STUDENT_PROJECT') || PROJECT_PLACEHOLDER;

    const { room, teacherInvite, teacherBridgeToken, studentBridgeToken } =
      await createRoomWithParticipants(baseUrl, sessionToken, {
        roomName,
        teacherName,
        studentAgentName,
        teacherAgentName,
      });

    // --- 4. emit artifacts to stdout -------------------------------------
    const studentServerUrl = `http://127.0.0.1:${serverPort}`;
    const roomUrlHint = roomUrl === ROOM_URL_PLACEHOLDER ? null : roomUrl;
    const bridgeToml = studentBridgeToml({
      humanName: studentName,
      agentName: studentAgentName,
      serverUrl: studentServerUrl,
      roomId: room.id,
      tokenEnv,
      projectRoot: studentProject,
      roomUrlHint,
    });

    out('');
    out('########################################################################');
    out('# OPERATOR NEXT STEP — expose the server through Tailscale (run in another');
    out('# terminal; this wizard never runs tailscale itself):');
    out('########################################################################');
    out('');
    out(serveCmd);
    out('');
    out('# Then, in the Tailscale admin console: Machines -> this host -> Share...');
    out('# to device-share it with the teacher, and apply the least-privilege grants');
    out('# in deploy/tailscale-policy.hujson (guest reaches only tcp:443).');
    out('');
    out('########################################################################');
    out('# STUDENT (you) — your own bridge.toml, MCP registration, and token');
    out('########################################################################');
    out('');
    out(`# 1. Save this as ${configPath} (edit [filesystem] roots to your project):`);
    out('# ----- begin bridge.toml -----');
    out(bridgeToml);
    out('# ----- end bridge.toml -----');
    out('');
    out(`# 2. Export your bridge token (shown ONCE — keep it safe):`);
    out(`export ${tokenEnv}="${studentBridgeToken}"`);
    out('');
    out('# 3. Register the bridge with Claude Code:');
    out(mcpAddLine(tokenEnv, configPath));
    out('');
    out(
      teacherOnboarding({
        teacherName,
        studentName,
        projectName,
        roomUrl,
        inviteToken: teacherInvite,
        bridgeToken: teacherBridgeToken,
        roomId: room.id,
        repoUrl,
        tokenEnv,
        configPath,
      }),
    );
    out('');

    // --- 5. optionally write the student config --------------------------
    const wantWrite =
      Boolean(flags['write-student-config']) || isEnvTrue(process.env.CLAUSROOM_HOST_WRITE_STUDENT_CONFIG);
    if (wantWrite) {
      await maybeWriteStudentConfig(bridgeToml, configPath, { interactive, assumeYes, rl, tokenEnv });
    } else {
      info(`[host-setup] not writing any config to disk (pass --write-student-config to write ${configPath}).`);
    }

    // --- reminders -------------------------------------------------------
    info('');
    info('[host-setup] DONE.');
    info('[host-setup] REMINDER: every token above is shown exactly ONCE — the server');
    info('[host-setup] stores only SHA-256 hashes. Copy them now. To rotate a token');
    info('[host-setup] later, use the room UI or POST /api/rooms/<id>/participants/<userId>/token.');
    if (roomUrl === ROOM_URL_PLACEHOLDER) {
      info('[host-setup] NOTE: no --room-url given, so the onboarding message uses a');
      info('[host-setup] placeholder URL. Re-run with --room-url once Tailscale Serve is up.');
    }
    if (startedServer) {
      info('[host-setup] NOTE: this wizard started a temporary server and will now stop it.');
      info('[host-setup] For a persistent room, run the server yourself (npm start) and');
      info('[host-setup] re-run this wizard with --invite in probe (--target) mode.');
    }

    if (startedServer) {
      info('[host-setup] stopping the temporary server...');
      await stopServer();
    }
  } finally {
    if (rl) rl.close();
  }
}

async function maybeWriteStudentConfig(content, rawPath, { interactive, assumeYes, rl, tokenEnv }) {
  const target = expandHome(rawPath);
  const exists = fs.existsSync(target);
  if (exists) {
    if (interactive && rl) {
      const ans = (await rl.question(`[host-setup] ${target} exists. Overwrite? [y/N]: `)).trim().toLowerCase();
      if (ans !== 'y' && ans !== 'yes') {
        info('[host-setup] keeping the existing config (not overwritten).');
        return;
      }
    } else if (!assumeYes) {
      info(`[host-setup] ${target} already exists; not overwriting (pass --yes to overwrite non-interactively).`);
      return;
    }
  } else if (interactive && rl) {
    const ans = (await rl.question(`[host-setup] Write the student bridge config to ${target}? [Y/n]: `))
      .trim()
      .toLowerCase();
    if (ans === 'n' || ans === 'no') {
      info('[host-setup] skipped writing the config.');
      return;
    }
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, content, { mode: 0o600 });
  info(`[host-setup] wrote ${target} (contains NO token — export ${tokenEnv} yourself).`);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const mode = positional[0];

  if (flags.help || flags.h) {
    process.stdout.write(mode === 'up' ? UP_HELP : HELP);
    return;
  }

  if (mode === 'up') {
    await runUp(flags);
    return;
  }

  // No subcommand (or a legacy stray positional) -> the guided wizard.
  await runWizard(flags);
}

main().catch((err) => {
  if (err instanceof WizardError) {
    info(`\n[host-setup] ERROR: ${err.message}`);
  } else {
    info(`\n[host-setup] UNEXPECTED ERROR: ${err && err.stack ? err.stack : String(err)}`);
  }
  stopServerSync();
  process.exitCode = 1;
});
