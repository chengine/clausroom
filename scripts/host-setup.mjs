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
  'help',
  'h',
]);

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

// ---------------------------------------------------------------------------
// server lifecycle (only used with --start)
// ---------------------------------------------------------------------------

let serverProc = null;
let startedServer = false;
let cleanupRegistered = false;

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const onSignal = (signal) => {
    info(`\n[host-setup] received ${signal}, cleaning up...`);
    stopServerSync();
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

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const HELP = `clausroom host setup wizard

Usage:
  npm run host -- [options]
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
`;

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  if (flags.help || flags.h) {
    process.stdout.write(HELP);
    return;
  }

  const assumeYes = Boolean(flags.yes);
  const interactive = Boolean(process.stdin.isTTY) && !flags['non-interactive'] && !assumeYes;
  const rl = interactive
    ? rlPromises.createInterface({ input: process.stdin, output: process.stderr })
    : null;

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
      const hostEnv = process.env.AGENT_ROOM_HOST;
      const connectHost =
        !hostEnv || hostEnv === '0.0.0.0' || hostEnv === '::' || hostEnv === '[::]' ? '127.0.0.1' : hostEnv;
      serverPort = started.port;
      baseUrl = `http://${connectHost}:${serverPort}`;
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

main().catch((err) => {
  if (err instanceof WizardError) {
    info(`\n[host-setup] ERROR: ${err.message}`);
  } else {
    info(`\n[host-setup] UNEXPECTED ERROR: ${err && err.stack ? err.stack : String(err)}`);
  }
  stopServerSync();
  process.exitCode = 1;
});
