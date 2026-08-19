/**
 * `clausroom host` and `clausroom connect` — the two commands that start a room.
 *
 * Host: start the server on loopback, create the room and its four
 * participants, wire up the local agent, then offer a direct connection and wait
 * for the answer. Everything the guest needs travels inside that offer.
 *
 * Connect: take the offer, answer it, and the room appears on a loopback URL.
 *
 * Both stay in the foreground for the life of the session and clean up after
 * themselves: the agent registration, the session file, and any child process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AUTO_READY } from './auto.js';
import { loadConfig, type Config } from './config.js';
import { peerHost, peerJoin, type RoomInvite } from './peer.js';
import { clearSession, readSession, writeSession, type Session } from './session.js';
import { forwardSignals, log, message as errorText, openBrowser, run } from './util.js';

export interface LaunchOptions {
  config?: string;
  open?: boolean;
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
 * Where the server lives. Next to this package in a checkout; otherwise the
 * operator has to say, because a global install is a copy with no repo around it.
 */
function serverEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'server', 'dist', 'index.js'),
    ...(process.env.CLAUSROOM_REPO
      ? [path.resolve(process.env.CLAUSROOM_REPO, 'apps', 'server', 'dist', 'index.js')]
      : []),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found) return found;
  throw new Error(
    'Cannot find the built room server. Run `npm run build` in the clausroom checkout, ' +
      'and set CLAUSROOM_REPO=/path/to/clausroom if you launch from elsewhere.',
  );
}

interface StartedServer {
  child: ChildProcess;
  port: number;
  url: string;
  invite: string;
}

/**
 * Start the server and wait for the two lines it prints on the way up. Its own
 * logs are relayed to stderr so a failure is visible rather than swallowed.
 */
function startServer(config: Config): Promise<StartedServer> {
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
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  if (!child.stdout) throw new Error('could not read the room server output');

  return new Promise((resolve, reject) => {
    let invite: string | null = null;
    const lines = readline.createInterface({ input: child.stdout as NodeJS.ReadableStream });
    const timer = setTimeout(() => {
      reject(new Error('the room server did not start within 20 seconds'));
    }, 20_000);
    const done = (err: Error | null, started?: StartedServer): void => {
      clearTimeout(timer);
      if (err) reject(err);
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
        done(null, { child, port, url: `http://127.0.0.1:${port}`, invite });
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
  log(`[clausroom] ${config.me.agent} can now use the room tools, limited to ${cwd}.`);
}

interface AutoChild {
  child: ChildProcess;
  detach: () => void;
}

/** Start the auto-responder and wait until it is actually watching the room. */
async function startAuto(config: Config): Promise<AutoChild> {
  const [node, entry] = selfCommand();
  const child = spawn(node as string, [entry as string, 'auto', '--config', config.file], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
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

/** Show the private browser URL, and open it unless asked not to. */
async function showBrowser(serverUrl: string, sessionToken: string, open: boolean): Promise<void> {
  // The token rides in the fragment, so it is never sent to the server as part
  // of a request; the page stores it and strips the fragment immediately.
  const url = `${serverUrl}/#clausroom-session=${encodeURIComponent(sessionToken)}`;
  if (open && (await openBrowser(url))) {
    log(`[clausroom] opened ${serverUrl} in your browser.`);
    return;
  }
  log(`[clausroom] open this private URL (do not share it): ${url}`);
}

/** Everything a session needs, minus the parts that differ between the two roles. */
async function begin(
  config: Config,
  session: Session,
  open: boolean,
  sessionToken: string,
): Promise<{ finish: () => Promise<void> }> {
  await writeSession(session);
  await attachAgent(config);
  const auto = config.agent.auto_reply ? await startAuto(config) : undefined;
  await showBrowser(session.server, sessionToken, open);
  return {
    finish: async () => {
      await stopChild(auto);
      await clearSession();
    },
  };
}

// ---------------------------------------------------------------------------
// host
// ---------------------------------------------------------------------------

export async function runHost(options: LaunchOptions): Promise<void> {
  const config = loadConfig(options.config);
  const server = await startServer(config);
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

    log(`[clausroom] room "${config.room.name}" is up at ${server.url}`);
    ({ finish } = await begin(
      config,
      {
        pid: process.pid,
        role: 'host',
        server: server.url,
        room: room.id,
        token: myAgent.bridge_token,
        me: config.me.name,
        agent_name: `${config.me.name}'s agent`,
        cursor: null,
      },
      options.open !== false,
      token,
    ));

    // Everything the guest needs is inside the offer: no second message, no
    // config to hand-edit, no token to paste anywhere.
    const invite: RoomInvite = {
      room: room.id,
      invite: partner.invite_token,
      token: theirAgent.bridge_token,
      human: config.partner.name,
      agent: `${config.partner.name}'s agent`,
    };
    log('[clausroom] send the offer line below to your partner over a channel you trust.');
    await peerHost({ port: server.port, stun: config.peer.stun, invite });
  } finally {
    detachServer();
    if (finish) await finish();
    await stopChild(server.child);
  }
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

export async function runConnect(options: LaunchOptions): Promise<void> {
  const config = loadConfig(options.config);
  let finish: (() => Promise<void>) | undefined;
  try {
    await peerJoin({
      port: config.peer.port,
      stun: config.peer.stun,
      onReady: async ({ url, invite }) => {
        const token = await login(url, invite.invite);
        log(`[clausroom] connected; the room is at ${url}`);
        // The names come from the offer: the host created these participants, so
        // their labels are the ones the room actually shows.
        ({ finish } = await begin(
          config,
          {
            pid: process.pid,
            role: 'guest',
            server: url,
            room: invite.room,
            token: invite.token,
            me: invite.human,
            agent_name: invite.agent,
            cursor: null,
          },
          options.open !== false,
          token,
        ));
      },
    });
  } finally {
    if (finish) await finish();
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
    log(`room:    "${info.room.name}" at ${session.server} as ${me.display_name}`);
    log(`others:  ${info.participants.map((p) => p.user.display_name).join(', ')}`);
    log('Everything checks out.');
    return 0;
  } catch (err) {
    log(`room:    FAILED — ${errorText(err)}`);
    return 1;
  }
}
