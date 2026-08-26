/**
 * `clausroom host` and `clausroom connect` — the two commands that start a room.
 *
 * Host: start the server on loopback, create the room and its four
 * participants, wire up the local agent, then hand WebRTC to the browser.
 *
 * Connect: serve a loopback switchboard; its browser answers the host invite.
 *
 * Both stay in the foreground for the life of the session and clean up after
 * themselves: the agent registration, the session file, and any child process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PEER, type PeerBootstrap, type PeerRoomInvite } from '@clausroom/protocol';
import { AUTO_READY } from './auto.js';
import { loadConfig, type Config } from './config.js';
import { startGuestRelay, type GuestRelay } from './peer.js';
import { clearSession, readSession, writeSession, type Session } from './session.js';
import {
  detectSshSession,
  forwardSignals,
  log,
  message as errorText,
  openBrowser,
  run,
} from './util.js';

export interface LaunchOptions {
  config?: string;
  open?: boolean;
  agent?: 'claude' | 'codex' | 'none';
  auto?: boolean;
}

function launchConfig(options: LaunchOptions): Config {
  return loadConfig(options.config, { agent: options.agent, auto: options.auto });
}

// ---------------------------------------------------------------------------
// The room server, as a child process
// ---------------------------------------------------------------------------

const InviteReply = z.object({ session_token: z.string().regex(/^arst_[0-9a-f]{32}$/) });
const RoomReply = z.object({ room: z.object({ id: z.string().regex(/^room_[0-9a-f]{24}$/) }) });
const ParticipantReply = z.object({
  participant: z.object({ user_id: z.string() }),
  invite_token: z.string().regex(/^arit_[0-9a-f]{32}$/).optional(),
  bridge_token: z.string().regex(/^arbt_[0-9a-f]{32}$/).optional(),
});

/**
 * The published CLI carries its server. A checkout build may use the adjacent
 * server dist instead, with CLAUSROOM_REPO retained as an explicit dev fallback.
 */
function serverEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'server.mjs'),
    path.resolve(here, '..', '..', 'server', 'dist', 'index.js'),
    ...(process.env.CLAUSROOM_REPO
      ? [path.resolve(process.env.CLAUSROOM_REPO, 'apps', 'server', 'dist', 'index.js')]
      : []),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(
    'Cannot find the bundled room server. Reinstall Clausroom, or run `npm run build` ' +
      'in its checkout.',
  );
}

interface StartedServer {
  child: ChildProcess;
  url: string;
  invite: string;
}

/**
 * Start the server and wait for the two lines it prints on the way up. Its own
 * logs are relayed to stderr so a failure is visible rather than swallowed.
 */
function startServer(config: Config, peerSecret: string): Promise<StartedServer> {
  const child = spawn(
    process.execPath,
    [
      serverEntry(),
      '--port',
      String(config.server.port),
      '--data',
      config.server.data,
      '--owner',
      config.me.name,
      '--peer-secret',
      peerSecret,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (!child.stdout) throw new Error('could not read the room server output');

  return new Promise((resolve, reject) => {
    let invite: string | null = null;
    let settled = false;
    const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
    const timer = setTimeout(
      () => done(new Error('the room server did not start within 20 seconds')),
      20_000,
    );
    const done = (err: Error | null, started?: StartedServer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        lines.close();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
        reject(err);
      }
      else if (started) resolve(started);
    };

    lines.on('line', (line) => {
      const inviteMatch = /^CLAUSROOM_INVITE (arit_[0-9a-f]{32})$/.exec(line);
      const portMatch = /^CLAUSROOM_LISTENING (\d+)$/.exec(line);
      if (inviteMatch?.[1]) {
        invite = inviteMatch[1];
      } else if (portMatch?.[1]) {
        if (!invite) return done(new Error('the room server printed no invite'));
        const port = Number(portMatch[1]);
        done(null, { child, url: `http://127.0.0.1:${port}`, invite });
      } else {
        log(`[server] ${line}`);
      }
    });
    child.once('error', (err) => done(err));
    child.once('exit', (code) => done(new Error(`the room server exited with code ${code}`)));
  });
}

async function api<T>(
  schema: z.ZodType<T>,
  method: string,
  url: string,
  opts: { token?: string; json?: unknown } = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? JSON.stringify((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(`${method} ${new URL(url).pathname} failed: ${detail}`);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new Error(`${method} ${new URL(url).pathname} returned something odd`);
  return parsed.data;
}

/** Exchange a one-time invite for a browser session token. */
function login(serverUrl: string, invite: string): Promise<string> {
  return api(InviteReply, 'POST', `${serverUrl}/api/auth/login`, {
    json: { invite_token: invite },
  }).then((reply) => reply.session_token);
}

// ---------------------------------------------------------------------------
// Wiring the local agent
// ---------------------------------------------------------------------------

/** This CLI, as an argv the agent can spawn later. */
function selfCommand(): string[] {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!entry || entry.endsWith('.ts')) {
    throw new Error('Run the built clausroom CLI (npm run install:cli), not the TypeScript source.');
  }
  return [process.execPath, entry];
}

/**
 * Point the local coding agent at this room by registering the bridge as its MCP
 * server, scoped to the project directory. Removing first makes it idempotent.
 */
async function attachAgent(config: Config): Promise<void> {
  if (config.me.agent === 'none') {
    log('[clausroom] me.agent is "none"; no coding agent was wired up.');
    return;
  }
  const [node, entry] = selfCommand();
  const serve = [node as string, entry as string, 'mcp', '--config', config.file];
  const cwd = config.project.dir;
  if (config.me.agent === 'codex') {
    await run('codex', ['mcp', 'remove', 'clausroom'], { cwd, stdio: 'ignore' }).catch(() => 0);
    await run('codex', ['mcp', 'add', 'clausroom', '--', ...serve], { cwd });
  } else {
    const scope = ['--scope', 'local'];
    await run('claude', ['mcp', 'remove', ...scope, 'clausroom'], { cwd, stdio: 'ignore' }).catch(
      () => 0,
    );
    await run(
      'claude',
      ['mcp', 'add', ...scope, '--transport', 'stdio', 'clausroom', '--', ...serve],
      { cwd },
    );
  }
  log(`[clausroom] ${config.me.agent} is attached; room file transfers are limited to ${cwd}.`);
}

interface AutoChild {
  child: ChildProcess;
  detach: () => void;
}

/** Start the auto-responder and wait until it is actually watching the room. */
async function startAuto(config: Config): Promise<AutoChild> {
  const [node, entry] = selfCommand();
  const child = spawn(
    node as string,
    [entry as string, 'auto', '--config', config.file, '--agent', config.me.agent],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  const detach = forwardSignals(child);
  const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the auto-responder never became ready')), 20_000);
      const finish = (err?: Error): void => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      lines.on('line', (line) => {
        if (line === AUTO_READY) finish();
        else process.stdout.write(`${line}\n`);
      });
      child.once('error', (err) => finish(new Error(`could not start the auto-responder: ${err.message}`)));
      child.once('exit', (code) => finish(new Error(`the auto-responder exited with code ${code}`)));
    });
  } catch (err) {
    detach();
    child.kill('SIGTERM');
    throw err;
  } finally {
    lines.close();
  }
  log('[clausroom] auto-reply is on: your agent will answer messages addressed to it.');
  return { child, detach };
}

async function stopChild(managed: AutoChild | ChildProcess | undefined): Promise<void> {
  if (!managed) return;
  const child = 'child' in managed ? managed.child : managed;
  if ('detach' in managed) managed.detach();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited) child.kill('SIGKILL');
}

function bootstrap(value: PeerBootstrap): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Show the private browser URL, and open it unless asked not to. */
async function showBrowser(
  serverUrl: string,
  peer: PeerBootstrap,
  open: boolean,
  sessionToken?: string,
): Promise<void> {
  // Credentials ride in the fragment, so they are not part of an HTTP request.
  const params = new URLSearchParams({ 'clausroom-peer': bootstrap(peer) });
  if (sessionToken) params.set('clausroom-session', sessionToken);
  const url = `${serverUrl}/#${params}`;
  const ssh = detectSshSession();
  if (!ssh && open && (await openBrowser(url))) {
    log('[clausroom] opened the private room in your browser.');
    return;
  }
  if (ssh) {
    log('[clausroom] SSH detected: open the room on the computer in front of you.');
    if (ssh.serverAddress && ssh.serverPort) {
      const parsedUrl = new URL(serverUrl);
      const port = Number(parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80));
      const destination = `${os.userInfo().username}@${ssh.serverAddress}`;
      log('[clausroom] on that computer, run this and leave it open:');
      log(
        `  clausroom ssh setup ${destination} --ssh-port ${ssh.serverPort} --clausroom-port ${port}`,
      );
      log('[clausroom] use your usual SSH destination in place of the one shown if it differs.');
    } else {
      log('[clausroom] this SSH session did not expose enough information to print an exact forward command.');
    }
  }
  log(`[clausroom] open this private URL (do not share it): ${url}`);
}

/** Everything a session needs, minus the parts that differ between the two roles. */
async function begin(
  config: Config,
  session: Session,
): Promise<{ finish: () => Promise<void> }> {
  let auto: AutoChild | undefined;
  try {
    await writeSession(session);
    await attachAgent(config);
    auto = config.agent.auto_reply ? await startAuto(config) : undefined;
    return {
      finish: async () => {
        await stopChild(auto);
        await clearSession();
      },
    };
  } catch (err) {
    await stopChild(auto);
    await clearSession();
    throw err;
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.removeListener('SIGINT', done);
      process.removeListener('SIGTERM', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
}

function waitForChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve();
      else reject(new Error(`the room server exited with code ${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

export async function runHost(options: LaunchOptions): Promise<void> {
  const config = launchConfig(options);
  const peerSecret = randomBytes(32).toString('hex');
  const server = await startServer(config, peerSecret);
  const detachServer = forwardSignals(server.child);
  let finish: (() => Promise<void>) | undefined;

  try {
    const token = await login(server.url, server.invite);
    const authed = { token };

    const { room } = await api(RoomReply, 'POST', `${server.url}/api/rooms`, {
      ...authed,
      json: { name: config.room.name },
    });
    const add = (display_name: string, kind: 'human' | 'agent', owner_user_id?: string) =>
      api(ParticipantReply, 'POST', `${server.url}/api/rooms/${room.id}/participants`, {
        ...authed,
        json: { display_name, kind, role: kind, ...(owner_user_id ? { owner_user_id } : {}) },
      });

    const partner = await add(config.partner.name, 'human');
    const myAgent = await add(`${config.me.name}'s agent`, 'agent');
    const theirAgent = await add(`${config.partner.name}'s agent`, 'agent', partner.participant.user_id);
    if (!partner.invite_token || !myAgent.bridge_token || !theirAgent.bridge_token) {
      throw new Error('the room server did not return the expected participant tokens');
    }

    log(`[clausroom] room "${config.room.name}" is ready.`);
    ({ finish } = await begin(config, {
      pid: process.pid,
      role: 'host',
      server: server.url,
      room: room.id,
      token: myAgent.bridge_token,
      me: config.me.name,
      agent_name: `${config.me.name}'s agent`,
      cursor: null,
    }));

    // Credentials leave this browser only after the DTLS-authenticated link is
    // live; the pasted invite code itself contains connection details only.
    const invite: PeerRoomInvite = {
      room: room.id,
      human_id: partner.participant.user_id,
      invite: partner.invite_token,
      token: theirAgent.bridge_token,
      human: config.partner.name,
      agent: `${config.partner.name}'s agent`,
    };
    await showBrowser(
      server.url,
      { v: PEER.VERSION, role: 'host', secret: peerSecret, stun: config.peer.stun, room: invite },
      options.open !== false,
      token,
    );
    log('[clausroom] the browser creates the private invite; leave this command running.');
    await waitForChild(server.child);
  } finally {
    detachServer();
    try {
      if (finish) await finish();
    } finally {
      await stopChild(server.child);
    }
  }
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

export async function runConnect(options: LaunchOptions): Promise<void> {
  const config = launchConfig(options);
  let finish: (() => Promise<void>) | undefined;
  let setup: Promise<void> | undefined;
  let relay: GuestRelay | undefined;
  let stopping = false;
  try {
    relay = await startGuestRelay({
      port: config.peer.port,
      onJoin: async (invite) => {
        if (!relay) throw new Error('the local browser relay is not ready');
        const token = await login(relay.url, invite.invite);
        if (stopping) throw new Error('the connector is stopping');
        if (!setup) {
          log('[clausroom] connected to the room.');
          // The host owns these participant labels; reconnects refresh only the
          // browser session, never the already-running local agent.
          setup = begin(config, {
            pid: process.pid,
            role: 'guest',
            server: relay.url,
            room: invite.room,
            token: invite.token,
            me: invite.human,
            agent_name: invite.agent,
            cursor: null,
          }).then((started) => {
            finish = started.finish;
          });
          void setup.catch(() => {
            setup = undefined;
          });
        }
        await setup;
        return token;
      },
    });
    await showBrowser(
      relay.url,
      { v: PEER.VERSION, role: 'guest', secret: relay.secret, stun: config.peer.stun },
      options.open !== false,
    );
    log('[clausroom] paste the browser invite there; leave this command running.');
    await waitForSignal();
  } finally {
    stopping = true;
    await setup?.catch(() => undefined);
    try {
      if (finish) await finish();
    } finally {
      if (relay) await relay.close();
    }
  }
}

// ---------------------------------------------------------------------------
// project
// ---------------------------------------------------------------------------

/** Re-point the local agent at the running room, e.g. after editing the config. */
export async function runProject(options: LaunchOptions): Promise<void> {
  const config = loadConfig(options.config);
  const session = await readSession();
  await attachAgent(config);
  log(`[clausroom] attached to "${session.room}" as ${session.agent_name}.`);
}

/** Check the config and, if a room is running, that it answers. */
export async function runCheck(options: LaunchOptions): Promise<number> {
  const config = loadConfig(options.config);
  log(`config:  ${config.file}`);
  log(`me:      ${config.me.name}, agent ${config.me.agent}`);
  log(`partner: ${config.partner.name}`);
  log(`project: ${config.project.dir}`);

  let session: Session;
  try {
    session = await readSession();
  } catch (err) {
    log(`room:    not running (${errorText(err)})`);
    log('The config is valid. Start a room with `clausroom host` or `clausroom connect`.');
    return 0;
  }

  const { RoomClient } = await import('./client.js');
  const client = new RoomClient(session.server, session.room, session.token);
  try {
    if (!(await client.healthy())) throw new Error('the server said it is not ok');
    const me = await client.me();
    const info = await client.info();
    log(`room:    "${info.room.name}" is reachable as ${me.display_name}`);
    log(`others:  ${info.participants.map((p) => p.user.display_name).join(', ')}`);
    log('Everything checks out.');
    return 0;
  } catch (err) {
    log(`room:    FAILED — ${errorText(err)}`);
    return 1;
  }
}
