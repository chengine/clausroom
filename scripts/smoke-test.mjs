#!/usr/bin/env node
/**
 * clausroom end-to-end smoke test.
 *
 * Boots the built server on an ephemeral port with a throwaway DB/artifact dir,
 * exercises the full contract surface (auth, rooms, participants, WS, turn
 * limit, pause, bridge MCP tools, artifact policy, export, static web), and
 * prints one "SMOKE <step> PASS|FAIL" line per step. Exits 0 only if every
 * step passed. All child processes are killed even on failure.
 *
 * No dependencies beyond the workspace node_modules (ws, @modelcontextprotocol/sdk).
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = path.join(REPO_ROOT, 'apps', 'server', 'dist', 'index.js');
const BRIDGE_ENTRY = path.join(REPO_ROOT, 'apps', 'bridge', 'dist', 'index.js');

const EXPECTED_TOOLS = [
  'room_get_status',
  'room_list_pending',
  'room_read_messages',
  'room_send_message',
  'room_wait_for_new_messages',
  'room_upload_artifact',
  'room_download_artifact',
  'room_request_human_approval',
  'room_check_approval',
  'room_mark_resolved',
];

// ---------------------------------------------------------------------------
// tiny assertion + step harness
// ---------------------------------------------------------------------------

class SmokeFailure extends Error {}

function assert(cond, message) {
  if (!cond) throw new SmokeFailure(message);
}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new SmokeFailure(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`SMOKE ${name} PASS`);
  } catch (err) {
    results.push({ name, passed: false, error: err });
    console.log(`SMOKE ${name} FAIL — ${err && err.message ? err.message : String(err)}`);
    if (!(err instanceof SmokeFailure) && err && err.stack) console.error(err.stack);
    throw new AbortRun(name);
  }
}
class AbortRun extends Error {
  constructor(stepName) {
    super(`aborted after failed step ${stepName}`);
  }
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

let baseUrl = '';

async function api(method, apiPath, { token, json, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let payload = body;
  if (json !== undefined) {
    h['content-type'] = 'application/json';
    payload = JSON.stringify(json);
  }
  const res = await fetch(`${baseUrl}${apiPath}`, {
    method,
    headers: h,
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });
  if (raw) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, headers: res.headers, buffer: buf };
  }
  const text = await res.text();
  let data = null;
  try {
    data = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, headers: res.headers, data };
}

function expectStatus(res, status, label) {
  if (res.status !== status) {
    throw new SmokeFailure(
      `${label}: expected HTTP ${status}, got ${res.status} (${JSON.stringify(res.data).slice(0, 300)})`,
    );
  }
  return res;
}

function expectError(res, status, code, label) {
  expectStatus(res, status, label);
  const got = res.data && res.data.error && res.data.error.code;
  assertEq(got, code, `${label} error code`);
  return res;
}

// ---------------------------------------------------------------------------
// WebSocket probe
// ---------------------------------------------------------------------------

class WsProbe {
  constructor(ws) {
    this.ws = ws;
    this.frames = [];
    this.waiters = new Set();
    this.closed = null;
    ws.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.frames.push(frame);
      for (const w of [...this.waiters]) w();
    });
    ws.on('close', (code) => {
      this.closed = code;
      for (const w of [...this.waiters]) w();
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const probe = new WsProbe(ws);
      const timer = setTimeout(() => reject(new SmokeFailure(`WS connect timeout: ${url}`)), 8000);
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

  /** Resolve with the first frame (from the whole buffer) matching pred, waiting up to timeoutMs. */
  waitFor(pred, timeoutMs, label) {
    const found = this.frames.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const check = () => {
        const hit = this.frames.find(pred);
        if (hit) {
          cleanup();
          resolve(hit);
        } else if (this.closed !== null) {
          cleanup();
          reject(new SmokeFailure(`WS closed (${this.closed}) while waiting for ${label}`));
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new SmokeFailure(`timed out after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// MCP helpers
// ---------------------------------------------------------------------------

function toolText(result) {
  return (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'clausroom-smoke-'));
  const artifactDir = path.join(tmpRoot, 'artifacts');
  const projectDir = path.join(tmpRoot, 'project');
  const downloadsDir = path.join(tmpRoot, 'downloads');
  const bridgeHome = path.join(tmpRoot, 'home');
  await fsp.mkdir(projectDir, { recursive: true });
  await fsp.mkdir(bridgeHome, { recursive: true });

  let serverProc = null;
  let mcp = null;
  const probes = [];
  const serverStdoutLines = [];

  // state shared across steps
  let bootstrapInvite = null;
  let port = null;
  let student = null; // { token, user }
  let teacher = null;
  let room = null;
  let teacherUserId = null;
  let studentAgentId = null;
  let teacherAgentId = null;
  let studentAgentBridgeToken = null;
  let teacherAgentBridgeToken = null;
  let studentProbe = null;
  let teacherProbe = null;
  let notesArtifactId = null;
  let notesSha256 = null;
  let bigApprovalId = null;
  let indexHtml = '';

  try {
    // -- a. boot the server ------------------------------------------------
    await step('server-boot', async () => {
      assert(fs.existsSync(SERVER_ENTRY), `server not built: ${SERVER_ENTRY} missing (run npm run build)`);
      assert(fs.existsSync(BRIDGE_ENTRY), `bridge not built: ${BRIDGE_ENTRY} missing (run npm run build)`);
      serverProc = spawn(process.execPath, [SERVER_ENTRY], {
        env: {
          ...process.env,
          AGENT_ROOM_HOST: '127.0.0.1',
          AGENT_ROOM_PORT: '0',
          AGENT_ROOM_DB: path.join(tmpRoot, 'clausroom.sqlite'),
          AGENT_ROOM_ARTIFACT_DIR: artifactDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
      const rl = readline.createInterface({ input: serverProc.stdout });

      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new SmokeFailure('timed out waiting for CLAUSROOM_LISTENING on server stdout')),
          15_000,
        );
        rl.on('line', (line) => {
          serverStdoutLines.push(line);
          const invite = line.match(/^CLAUSROOM_BOOTSTRAP_INVITE (arit_[0-9a-f]{32})$/);
          if (invite) bootstrapInvite = invite[1];
          const listening = line.match(/^CLAUSROOM_LISTENING (\d+)$/);
          if (listening) {
            port = Number(listening[1]);
            clearTimeout(timer);
            resolve();
          }
        });
        serverProc.on('exit', (code) => {
          clearTimeout(timer);
          reject(new SmokeFailure(`server exited early with code ${code}`));
        });
      });
      assert(bootstrapInvite, 'no CLAUSROOM_BOOTSTRAP_INVITE line on first run');
      assert(Number.isInteger(port) && port > 0, `bad port: ${port}`);
      baseUrl = `http://127.0.0.1:${port}`;
    });

    // -- b. bootstrap login + room ------------------------------------------
    await step('bootstrap-login', async () => {
      const res = expectStatus(
        await api('POST', '/api/auth/login', { json: { invite_token: bootstrapInvite } }),
        200,
        'login',
      );
      assert(typeof res.data.session_token === 'string' && res.data.session_token.startsWith('arst_'), 'no session token');
      assertEq(res.data.user.kind, 'human', 'bootstrap user kind');
      assertEq(res.data.user.is_admin, true, 'bootstrap user is_admin');
      student = { token: res.data.session_token, user: res.data.user };
      // invite is single-use: reuse must 401
      expectError(
        await api('POST', '/api/auth/login', { json: { invite_token: bootstrapInvite } }),
        401,
        'unauthorized',
        'invite reuse',
      );
    });

    await step('create-room', async () => {
      const res = expectStatus(
        await api('POST', '/api/rooms', { token: student.token, json: { name: 'Depth Regularizer Debug' } }),
        201,
        'create room',
      );
      room = res.data.room;
      assertEq(room.name, 'Depth Regularizer Debug', 'room name');
      assertEq(room.agents_paused, false, 'room agents_paused');
    });

    // -- c. participants -----------------------------------------------------
    await step('add-participants', async () => {
      const teacherRes = expectStatus(
        await api('POST', `/api/rooms/${room.id}/participants`, {
          token: student.token,
          json: { display_name: 'Teacher', kind: 'human', role: 'human' },
        }),
        201,
        'add Teacher',
      );
      const teacherInvite = teacherRes.data.invite_token;
      assert(typeof teacherInvite === 'string' && teacherInvite.startsWith('arit_'), 'Teacher invite token missing');
      teacherUserId = teacherRes.data.participant.user_id;

      const studentAgentRes = expectStatus(
        await api('POST', `/api/rooms/${room.id}/participants`, {
          token: student.token,
          json: { display_name: 'Student Agent', kind: 'agent', role: 'agent' },
        }),
        201,
        'add Student Agent',
      );
      studentAgentBridgeToken = studentAgentRes.data.bridge_token;
      assert(studentAgentBridgeToken && studentAgentBridgeToken.startsWith('arbt_'), 'Student Agent bridge token missing');
      studentAgentId = studentAgentRes.data.participant.user_id;
      assertEq(studentAgentRes.data.participant.user.owner_user_id, student.user.id, 'Student Agent owner');

      const teacherAgentRes = expectStatus(
        await api('POST', `/api/rooms/${room.id}/participants`, {
          token: student.token,
          json: {
            display_name: 'Teacher Agent',
            kind: 'agent',
            role: 'agent',
            owner_user_id: teacherUserId,
          },
        }),
        201,
        'add Teacher Agent',
      );
      teacherAgentBridgeToken = teacherAgentRes.data.bridge_token;
      assert(teacherAgentBridgeToken && teacherAgentBridgeToken.startsWith('arbt_'), 'Teacher Agent bridge token missing');
      teacherAgentId = teacherAgentRes.data.participant.user_id;
      assertEq(teacherAgentRes.data.participant.user.owner_user_id, teacherUserId, 'Teacher Agent owner');

      const teacherLogin = expectStatus(
        await api('POST', '/api/auth/login', { json: { invite_token: teacherInvite } }),
        200,
        'teacher login',
      );
      teacher = { token: teacherLogin.data.session_token, user: teacherLogin.data.user };
      assertEq(teacher.user.id, teacherUserId, 'teacher login user id');
    });

    // -- d. WS hello + broadcast ---------------------------------------------
    await step('ws-hello', async () => {
      const wsBase = `ws://127.0.0.1:${port}/ws?room_id=${room.id}`;
      studentProbe = await WsProbe.connect(`${wsBase}&token=${student.token}`);
      probes.push(studentProbe);
      teacherProbe = await WsProbe.connect(`${wsBase}&token=${teacher.token}`);
      probes.push(teacherProbe);

      for (const [label, probe, userId] of [
        ['student', studentProbe, student.user.id],
        ['teacher', teacherProbe, teacher.user.id],
      ]) {
        const hello = await probe.waitFor((f) => f.type === 'hello', 5000, `${label} hello`);
        assertEq(hello.room.id, room.id, `${label} hello room id`);
        const ids = hello.participants.map((p) => p.user_id).sort();
        const expected = [student.user.id, teacherUserId, studentAgentId, teacherAgentId].sort();
        assertEq(JSON.stringify(ids), JSON.stringify(expected), `${label} hello participants`);
        assert(hello.presence.includes(userId), `${label} hello presence should include self`);
        const owner = hello.participants.find((p) => p.user_id === student.user.id);
        assertEq(owner.role, 'owner', `${label} hello owner role`);
      }
    });

    await step('message-broadcast', async () => {
      const res = expectStatus(
        await api('POST', `/api/rooms/${room.id}/messages`, {
          token: student.token,
          json: {
            recipient_ids: [],
            message_type: 'human_message',
            body_markdown: 'Why does `depth_regularizer.py` blow up on batch 3?',
          },
        }),
        201,
        'post human message',
      );
      const msgId = res.data.message.id;
      assertEq(res.data.message.sender.id, student.user.id, 'sender derived from token');
      for (const [label, probe] of [
        ['student', studentProbe],
        ['teacher', teacherProbe],
      ]) {
        const frame = await probe.waitFor(
          (f) => f.type === 'message_created' && f.message.id === msgId,
          5000,
          `${label} message_created`,
        );
        assertEq(frame.message.body_markdown, res.data.message.body_markdown, `${label} broadcast body`);
      }
    });

    // -- e. turn limit ---------------------------------------------------------
    await step('turn-limit', async () => {
      for (let i = 1; i <= 3; i += 1) {
        expectStatus(
          await api('POST', `/api/rooms/${room.id}/messages`, {
            token: studentAgentBridgeToken,
            json: { message_type: 'agent_answer', body_markdown: `Agent finding #${i}: still digging.` },
          }),
          201,
          `agent message ${i}`,
        );
      }
      const fourth = expectError(
        await api('POST', `/api/rooms/${room.id}/messages`, {
          token: studentAgentBridgeToken,
          json: { message_type: 'agent_answer', body_markdown: 'Agent finding #4: should be blocked.' },
        }),
        429,
        'turn_limit',
        '4th consecutive agent message',
      );
      assertEq(
        fourth.data.error.message,
        'Agent turn limit reached (3 consecutive agent messages). Stop now and wait for a human to reply before sending more messages.',
        'turn_limit message',
      );
      // a human message resets the run
      expectStatus(
        await api('POST', `/api/rooms/${room.id}/messages`, {
          token: student.token,
          json: { message_type: 'human_message', body_markdown: 'Thanks — keep going.' },
        }),
        201,
        'human reset message',
      );
      expectStatus(
        await api('POST', `/api/rooms/${room.id}/messages`, {
          token: studentAgentBridgeToken,
          json: { message_type: 'agent_answer', body_markdown: 'Back on it after the human reply.' },
        }),
        201,
        'agent message after reset',
      );
    });

    // -- f. pause ----------------------------------------------------------------
    await step('pause-agents', async () => {
      const pauseRes = expectStatus(
        await api('POST', `/api/rooms/${room.id}/pause`, {
          token: student.token,
          json: { target: 'all_agents', paused: true },
        }),
        200,
        'pause all agents',
      );
      assertEq(pauseRes.data.room.agents_paused, true, 'agents_paused after pause');
      expectError(
        await api('POST', `/api/rooms/${room.id}/messages`, {
          token: studentAgentBridgeToken,
          json: { message_type: 'agent_answer', body_markdown: 'Should be paused.' },
        }),
        403,
        'agents_paused',
        'agent message while paused',
      );
      const resumeRes = expectStatus(
        await api('POST', `/api/rooms/${room.id}/pause`, {
          token: student.token,
          json: { target: 'all_agents', paused: false },
        }),
        200,
        'unpause all agents',
      );
      assertEq(resumeRes.data.room.agents_paused, false, 'agents_paused after resume');
    });

    // -- g. bridge over MCP stdio -----------------------------------------------
    await step('mcp-connect-tools', async () => {
      await fsp.writeFile(
        path.join(projectDir, 'notes.md'),
        '# Debug notes\n\nThe depth regularizer overflows when lambda > 10.\n',
      );
      await fsp.writeFile(path.join(projectDir, '.env'), 'OPENAI_API_KEY=sk-test1234567890\n');
      await fsp.writeFile(path.join(projectDir, 'big.bin'), randomBytes(2 * 1024 * 1024));
      notesSha256 = sha256Hex(await fsp.readFile(path.join(projectDir, 'notes.md')));

      const bridgeConfigPath = path.join(tmpRoot, 'bridge.toml');
      await fsp.writeFile(
        bridgeConfigPath,
        [
          '[identity]',
          'human_name  = "Student"',
          'agent_name  = "Student Agent"',
          'bridge_name = "smoke-bridge"',
          '',
          '[room]',
          `server_url = "${baseUrl}"`,
          `room_id    = "${room.id}"`,
          'token_env  = "AGENT_ROOM_BRIDGE_TOKEN"',
          '',
          '[policy]',
          'read_only_default                  = false',
          'allow_agent_to_send_text           = true',
          'allow_agent_to_upload_files        = true',
          'require_human_approval_for_uploads = false',
          'max_upload_bytes_without_approval  = 1048576',
          'max_upload_bytes_absolute          = 104857600',
          '',
          '[filesystem]',
          `roots         = ["${projectDir}"]`,
          `downloads_dir = "${downloadsDir}"`,
          '',
        ].join('\n'),
      );

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [BRIDGE_ENTRY, 'mcp', '--config', bridgeConfigPath],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: bridgeHome,
          AGENT_ROOM_BRIDGE_TOKEN: studentAgentBridgeToken,
        },
        stderr: 'pipe',
      });
      mcp = new Client({ name: 'clausroom-smoke', version: '0.1.0' });
      await mcp.connect(transport);
      if (transport.stderr) {
        transport.stderr.on('data', (d) => process.stderr.write(`[bridge] ${d}`));
      }

      const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
      assertEq(JSON.stringify(tools), JSON.stringify([...EXPECTED_TOOLS].sort()), 'MCP tool list');
    });

    await step('mcp-basic-tools', async () => {
      const status = await mcp.callTool({ name: 'room_get_status', arguments: {} });
      assert(!status.isError, `room_get_status errored: ${toolText(status)}`);
      assert(toolText(status).includes('Depth Regularizer Debug'), 'room_get_status should name the room');
      assert(toolText(status).includes(studentAgentId), 'room_get_status should include my user id');

      const pending = await mcp.callTool({ name: 'room_list_pending', arguments: {} });
      assert(!pending.isError, `room_list_pending errored: ${toolText(pending)}`);
      assert(
        toolText(pending).includes('depth_regularizer.py'),
        'room_list_pending should include the human question',
      );

      const read = await mcp.callTool({ name: 'room_read_messages', arguments: {} });
      assert(!read.isError, `room_read_messages errored: ${toolText(read)}`);
      assert(toolText(read).includes('Cursor advanced'), 'room_read_messages should advance the cursor');
      assert(toolText(read).includes('Thanks — keep going.'), 'room_read_messages should include the reset message');

      const send = await mcp.callTool({
        name: 'room_send_message',
        arguments: {
          message_type: 'agent_answer',
          body_markdown: 'The overflow is an fp16 issue in `depth_regularizer.py` line 42.',
          confidence: 'high',
        },
      });
      assert(!send.isError, `room_send_message errored: ${toolText(send)}`);
      const sentId = (toolText(send).match(/msg_[0-9a-f]{24}/) ?? [])[0];
      assert(sentId, `no message id in room_send_message result: ${toolText(send)}`);
      for (const [label, probe] of [
        ['student', studentProbe],
        ['teacher', teacherProbe],
      ]) {
        const frame = await probe.waitFor(
          (f) => f.type === 'message_created' && f.message.id === sentId,
          5000,
          `${label} agent message_created`,
        );
        assertEq(frame.message.sender.id, studentAgentId, `${label} agent message sender`);
      }

      // contract §12: room_send_message accepts recipient_ids (addressed send).
      const addressed = await mcp.callTool({
        name: 'room_send_message',
        arguments: {
          message_type: 'agent_question',
          body_markdown: 'Teacher Agent: can you confirm the fp16 overflow on your side?',
          recipient_ids: [teacherAgentId],
        },
      });
      assert(!addressed.isError, `addressed room_send_message errored: ${toolText(addressed)}`);
      const addressedId = (toolText(addressed).match(/msg_[0-9a-f]{24}/) ?? [])[0];
      const addressedFrame = await teacherProbe.waitFor(
        (f) => f.type === 'message_created' && f.message.id === addressedId,
        5000,
        'addressed message_created (recipients are advisory, everyone gets the frame)',
      );
      assertEq(JSON.stringify(addressedFrame.message.recipient_ids), JSON.stringify([teacherAgentId]), 'recipient_ids');
    });

    // -- h. artifact policy ------------------------------------------------------
    await step('artifact-upload-clean', async () => {
      const res = await mcp.callTool({
        name: 'room_upload_artifact',
        arguments: { path: path.join(projectDir, 'notes.md'), description: 'Debug notes for the regularizer.' },
      });
      assert(!res.isError, `clean upload errored: ${toolText(res)}`);
      notesArtifactId = (toolText(res).match(/art_[0-9a-f]{24}/) ?? [])[0];
      assert(notesArtifactId, `no artifact id in upload result: ${toolText(res)}`);
      const frame = await studentProbe.waitFor(
        (f) =>
          f.type === 'message_created' &&
          f.message.message_type === 'artifact_uploaded' &&
          f.message.artifact_ids.includes(notesArtifactId),
        5000,
        'artifact_uploaded message',
      );
      assertEq(frame.message.sender.id, studentAgentId, 'artifact message sender');
    });

    await step('artifact-secret-refused', async () => {
      const res = await mcp.callTool({
        name: 'room_upload_artifact',
        arguments: { path: path.join(projectDir, '.env'), description: 'Should never be uploaded.' },
      });
      assert(res.isError, '.env upload must be refused by the bridge');
      assert(
        toolText(res).includes('Refused by local bridge policy'),
        `unexpected refusal text: ${toolText(res)}`,
      );
      // and it must never have reached the server
      const list = expectStatus(
        await api('GET', `/api/rooms/${room.id}/artifacts`, { token: student.token }),
        200,
        'artifact list',
      );
      assert(
        list.data.artifacts.every((a) => a.filename !== '.env'),
        '.env must not appear among room artifacts',
      );
    });

    await step('artifact-approval-flow', async () => {
      const first = await mcp.callTool({
        name: 'room_upload_artifact',
        arguments: { path: path.join(projectDir, 'big.bin'), description: '2MB of profiler output.' },
      });
      const firstText = toolText(first);
      assert(firstText.includes('APPROVAL REQUIRED'), `expected approval gate, got: ${firstText}`);
      bigApprovalId = (firstText.match(/apr_[0-9a-f]{24}/) ?? [])[0];
      assert(bigApprovalId, `no approval id in: ${firstText}`);

      // teacher is NOT the reviewer (Student Agent is owned by the student)
      expectError(
        await api('POST', `/api/rooms/${room.id}/approvals/${bigApprovalId}/respond`, {
          token: teacher.token,
          json: { decision: 'approved' },
        }),
        403,
        'forbidden',
        'teacher approving student-agent approval',
      );

      // the student (reviewer) approves
      const approve = expectStatus(
        await api('POST', `/api/rooms/${room.id}/approvals/${bigApprovalId}/respond`, {
          token: student.token,
          json: { decision: 'approved' },
        }),
        200,
        'student approves',
      );
      assertEq(approve.data.approval.status, 'approved', 'approval status');
      await studentProbe.waitFor(
        (f) => f.type === 'approval_resolved' && f.approval.id === bigApprovalId,
        5000,
        'approval_resolved frame',
      );
      await studentProbe.waitFor(
        (f) =>
          f.type === 'message_created' &&
          f.message.message_type === 'system_event' &&
          f.message.body_markdown.includes(bigApprovalId),
        5000,
        'approval system_event message',
      );

      // retry with the approved approval id
      const retry = await mcp.callTool({
        name: 'room_upload_artifact',
        arguments: {
          path: path.join(projectDir, 'big.bin'),
          description: '2MB of profiler output.',
          approval_id: bigApprovalId,
        },
      });
      assert(!retry.isError, `approved upload errored: ${toolText(retry)}`);
      assert(/art_[0-9a-f]{24}/.test(toolText(retry)), `no artifact id in approved upload: ${toolText(retry)}`);
    });

    await step('artifact-download-verify', async () => {
      const res = await mcp.callTool({
        name: 'room_download_artifact',
        arguments: { artifact_id: notesArtifactId },
      });
      assert(!res.isError, `download errored: ${toolText(res)}`);
      const m = toolText(res).match(/saved to (.+?) \(\d+ bytes/);
      assert(m, `no local path in download result: ${toolText(res)}`);
      const localPath = m[1];
      assert(localPath.startsWith(downloadsDir + path.sep), `download escaped downloads_dir: ${localPath}`);
      const content = await fsp.readFile(localPath);
      assertEq(sha256Hex(content), notesSha256, 'downloaded notes.md sha256');
    });

    await step('artifact-path-traversal', async () => {
      const boundary = `----clausroomsmoke${randomBytes(8).toString('hex')}`;
      const fileContent = 'path traversal probe\n';
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            'Content-Disposition: form-data; name="file"; filename="../../evil.txt"\r\n' +
            'Content-Type: text/plain\r\n\r\n',
        ),
        Buffer.from(fileContent),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const res = expectStatus(
        await api('POST', `/api/rooms/${room.id}/artifacts`, {
          token: student.token,
          body,
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        }),
        201,
        'traversal upload',
      );
      assertEq(res.data.artifact.filename, 'evil.txt', 'sanitized filename');
      const sha = sha256Hex(Buffer.from(fileContent));
      const expectedStored = path.join(artifactDir, room.id, res.data.artifact.id, `${sha}__evil.txt`);
      assert(fs.existsSync(expectedStored), `stored file not at ${expectedStored}`);

      // nothing named evil.txt may exist outside the artifact root
      const escapees = [];
      const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(p);
          else if (entry.name.includes('evil') && !p.startsWith(artifactDir + path.sep)) escapees.push(p);
        }
      };
      walk(tmpRoot);
      assert(escapees.length === 0, `file escaped the artifact root: ${escapees.join(', ')}`);
      assert(!fs.existsSync(path.join(tmpRoot, 'evil.txt')), 'evil.txt escaped to the temp root');
      assert(!fs.existsSync(path.join(path.dirname(artifactDir), 'evil.txt')), 'evil.txt escaped above artifact dir');
    });

    // -- i. export, healthz, static web -------------------------------------------
    await step('export-transcript', async () => {
      const res = await api('GET', `/api/rooms/${room.id}/export.md`, { token: student.token, raw: true });
      assertEq(res.status, 200, 'export status');
      assert(
        (res.headers.get('content-type') ?? '').startsWith('text/markdown'),
        `export content-type: ${res.headers.get('content-type')}`,
      );
      assertEq(
        res.headers.get('content-disposition'),
        `attachment; filename="${room.id}-transcript.md"`,
        'export content-disposition',
      );
      const md = res.buffer.toString('utf8');
      assert(md.includes('# Depth Regularizer Debug'), 'export must start with the room name H1');
      assert(md.includes('Why does `depth_regularizer.py` blow up on batch 3?'), 'export must include the human question');
      assert(md.includes('fp16 issue'), 'export must include the agent answer');
      assert(md.includes('notes.md'), 'export must list the notes.md artifact');
    });

    await step('healthz', async () => {
      const res = expectStatus(await api('GET', '/healthz'), 200, 'healthz');
      assertEq(res.data.ok, true, 'healthz body');
    });

    await step('static-web', async () => {
      const res = await api('GET', '/', { raw: true });
      assertEq(res.status, 200, 'GET / status');
      assert((res.headers.get('content-type') ?? '').includes('text/html'), 'GET / content-type');
      indexHtml = res.buffer.toString('utf8');
      assert(indexHtml.includes('<title>clausroom</title>'), 'index.html marker <title>clausroom</title>');
      assert(indexHtml.includes('id="root"'), 'index.html root div');
      const assetMatch = indexHtml.match(/\/assets\/[A-Za-z0-9._-]+\.js/);
      assert(assetMatch, 'no hashed /assets/*.js reference in index.html');
      const asset = await api('GET', assetMatch[0], { raw: true });
      assertEq(asset.status, 200, `asset ${assetMatch[0]} status`);
      assert(
        (asset.headers.get('content-type') ?? '').includes('javascript'),
        `asset content-type: ${asset.headers.get('content-type')}`,
      );
      assert(asset.buffer.length > 10_000, 'asset suspiciously small');
      // SPA fallback
      const spa = await api('GET', '/rooms/whatever', { raw: true });
      assertEq(spa.status, 200, 'SPA fallback status');
      assert(spa.buffer.toString('utf8').includes('<title>clausroom</title>'), 'SPA fallback serves index.html');
    });
  } catch (err) {
    if (!(err instanceof AbortRun)) {
      console.error('unexpected harness error:', err);
      results.push({ name: 'harness', passed: false, error: err });
    }
  } finally {
    // Kill every child, even on failure.
    for (const probe of probes) probe.close();
    if (mcp) {
      try {
        await mcp.close(); // closes the stdio transport and kills the bridge
      } catch {
        /* ignore */
      }
    }
    if (serverProc && serverProc.exitCode === null) {
      const exited = new Promise((resolve) => serverProc.once('exit', resolve));
      serverProc.kill('SIGTERM');
      const timeout = sleep(5000).then(() => 'timeout');
      if ((await Promise.race([exited, timeout])) === 'timeout') {
        serverProc.kill('SIGKILL');
        await exited;
      }
    }
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }

  const failed = results.filter((r) => !r.passed);
  console.log(
    `SMOKE summary: ${results.length - failed.length}/${results.length} steps passed${
      failed.length > 0 ? ` — FAILED: ${failed.map((f) => f.name).join(', ')}` : ''
    }`,
  );
  process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
