/**
 * Directory-independent Clausroom commands.
 *
 * `host` and `connect`, run from a project root, own the network process and
 * convert only that directory into an MCP filesystem allow-list. `project`
 * can switch the attached root while a connection is running. The short-lived
 * connection record is mode 0600 and contains no human browser session token.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from './config.js';
import { runMcpServer } from './mcp.js';
import { runPeerJoin } from './peer.js';

const STATE_VERSION = 1;
const STATE_FILE = 'active-room.json';
const TOKEN_ENV = 'AGENT_ROOM_BRIDGE_TOKEN';

type ActiveRole = 'host' | 'guest';

interface ActiveRoom {
  v: typeof STATE_VERSION;
  connectionId: string;
  pid: number;
  role: ActiveRole;
  serverUrl: string;
  roomId: string;
  bridgeToken: string;
  humanName: string;
  agentName: string;
  createdAt: string;
}

interface HostContext {
  v: typeof STATE_VERSION;
  sessionToken: string;
  serverUrl: string;
  roomId: string;
  bridgeToken: string;
  humanName: string;
  agentName: string;
}

export interface HostCommandOptions {
  ssh?: string;
  repo?: string;
  remoteDir?: string;
  localPort?: number;
  serverPort?: number;
  roomName?: string;
  hostName?: string;
  guestName?: string;
  skipSetup?: boolean;
  stun?: boolean;
  open?: boolean;
  project?: boolean;
  agent?: ProjectCommandOptions['agent'];
  allowAgentUploads?: boolean;
  auto?: boolean;
}

export interface ConnectCommandOptions {
  offerFile?: string;
  listenPort?: number;
  stunUrls?: string[];
  open?: boolean;
  project?: boolean;
  agent?: ProjectCommandOptions['agent'];
  allowAgentUploads?: boolean;
  auto?: boolean;
}

export interface ProjectCommandOptions {
  agent: 'codex' | 'claude' | 'none';
  allowAgentUploads?: boolean;
  auto?: boolean;
}

interface ManagedProjectAuto {
  child: ChildProcess;
  stopping: boolean;
  removeForwarding: () => void;
}

function stateDir(): string {
  return process.env.CLAUSROOM_STATE_DIR
    ? path.resolve(process.env.CLAUSROOM_STATE_DIR)
    : path.join(os.homedir(), '.clausroom');
}

function activeStatePath(): string {
  return path.join(stateDir(), STATE_FILE);
}

function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1') &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

function validActiveRoom(value: unknown): value is ActiveRoom {
  if (typeof value !== 'object' || value === null) return false;
  const room = value as Partial<ActiveRoom>;
  return (
    room.v === STATE_VERSION &&
    typeof room.connectionId === 'string' &&
    /^[A-Za-z0-9_-]{16,64}$/.test(room.connectionId) &&
    typeof room.pid === 'number' &&
    Number.isSafeInteger(room.pid) &&
    room.pid > 0 &&
    (room.role === 'host' || room.role === 'guest') &&
    typeof room.serverUrl === 'string' &&
    isLoopbackUrl(room.serverUrl) &&
    typeof room.roomId === 'string' &&
    /^room_[0-9a-f]{24}$/.test(room.roomId) &&
    typeof room.bridgeToken === 'string' &&
    /^arbt_[0-9a-f]{32}$/.test(room.bridgeToken) &&
    validIdentity(room.humanName) &&
    validIdentity(room.agentName) &&
    typeof room.createdAt === 'string'
  );
}

function validHostContext(value: unknown): value is HostContext {
  if (typeof value !== 'object' || value === null) return false;
  const context = value as Partial<HostContext>;
  return (
    context.v === STATE_VERSION &&
    typeof context.sessionToken === 'string' &&
    /^arst_[0-9a-f]{32}$/.test(context.sessionToken) &&
    typeof context.serverUrl === 'string' &&
    isLoopbackUrl(context.serverUrl) &&
    typeof context.roomId === 'string' &&
    /^room_[0-9a-f]{24}$/.test(context.roomId) &&
    typeof context.bridgeToken === 'string' &&
    /^arbt_[0-9a-f]{32}$/.test(context.bridgeToken) &&
    validIdentity(context.humanName) &&
    validIdentity(context.agentName)
  );
}

async function ensureStateDir(): Promise<string> {
  const dir = stateDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Clausroom state directory: ${dir}`);
  }
  await fsp.chmod(dir, 0o700);
  return dir;
}

async function atomicPrivateWrite(file: string, contents: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fsp.open(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600);
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fsp.unlink(temp).catch(() => undefined);
    throw err;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeActiveRoom(room: ActiveRoom): Promise<void> {
  await ensureStateDir();
  await atomicPrivateWrite(activeStatePath(), `${JSON.stringify(room, null, 2)}\n`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readActiveRoom(): Promise<ActiveRoom> {
  const file = activeStatePath();
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No active Clausroom connection. Run `clausroom host` or `clausroom connect` first.');
    }
    throw err;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Clausroom state path: ${file}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`Refusing Clausroom state with permissions broader than 0600: ${file}`);
  }
  const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'));
  if (!validActiveRoom(parsed)) {
    throw new Error(`Invalid Clausroom connection state: ${file}`);
  }
  if (!processIsAlive(parsed.pid)) {
    await fsp.unlink(file).catch(() => undefined);
    throw new Error('The previous Clausroom connection is no longer running. Start host/connect again.');
  }
  return parsed;
}

async function clearActiveRoom(connectionId: string): Promise<void> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(activeStatePath(), 'utf8'));
    if (validActiveRoom(parsed) && parsed.connectionId === connectionId) {
      await fsp.unlink(activeStatePath());
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(`[clausroom] could not clear local connection state: ${String(err)}\n`);
    }
  }
}

function sessionUrl(serverUrl: string, sessionToken: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/#clausroom-session=${encodeURIComponent(sessionToken)}`;
}

async function openBrowser(url: string): Promise<boolean> {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    let settled = false;
    const finish = (opened: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(opened);
    };
    const timer = setTimeout(() => {
      child.unref();
      finish(false);
    }, 10_000);
    child.once('error', () => finish(false));
    child.once('exit', (code) => finish(code === 0));
  });
}

function decodeHostContext(encoded: string): HostContext {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new Error('host returned malformed local connection context');
  }
  if (!validHostContext(parsed)) {
    throw new Error('host returned invalid local connection context');
  }
  return parsed;
}

function validatePort(value: number | undefined, fallback: number, label: string): number {
  const port = value ?? fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function remoteDirectoryCommand(raw: string): string {
  if (raw.includes('\0') || raw.split('/').includes('..')) {
    throw new Error('--remote-dir must not contain NUL bytes or .. path segments');
  }
  if (raw.startsWith('~/')) {
    return `"$HOME"/${shellQuote(raw.slice(2))}`;
  }
  if (!path.posix.isAbsolute(raw)) {
    throw new Error('--remote-dir must be absolute or begin with ~/');
  }
  return shellQuote(raw);
}

function validateSshTarget(target: string): void {
  if (
    target.startsWith('-') ||
    target.length > 255 ||
    !/^(?:[A-Za-z0-9_.-]+@)?(?:[A-Za-z0-9_.-]+|\[[0-9A-Fa-f:]+\])$/.test(target)
  ) {
    throw new Error('--ssh must be a plain [user@]hostname or IP address');
  }
}

async function findLocalRepo(explicit?: string): Promise<string> {
  const candidates: string[] = [];
  if (explicit) {
    candidates.push(path.resolve(explicit));
  } else if (process.env.CLAUSROOM_REPO) {
    candidates.push(path.resolve(process.env.CLAUSROOM_REPO));
  } else {
    let current = path.resolve(process.cwd());
    while (true) {
      candidates.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    candidates.push(path.join(os.homedir(), 'StanfordMSL', 'clausroom'));
  }
  for (const candidate of [...new Set(candidates)]) {
    try {
      await fsp.access(path.join(candidate, 'scripts', 'host-setup.mjs'), fs.constants.R_OK);
      await fsp.access(path.join(candidate, 'package.json'), fs.constants.R_OK);
      return await fsp.realpath(candidate);
    } catch {
      // Try the next well-known/source-tree candidate.
    }
  }
  throw new Error(
    'Could not find the Clausroom source checkout. Pass `--repo /path/to/clausroom` or set CLAUSROOM_REPO.',
  );
}

function waitForChild(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) resolve(128);
      else resolve(code ?? 1);
    });
  });
}

function installChildForwarding(child: ChildProcess): () => void {
  const interrupt = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  };
  const terminate = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  return () => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  };
}

function validateAutoRequest(
  auto: boolean | undefined,
  attachProject: boolean,
  agent: ProjectCommandOptions['agent'],
  ssh = false,
): void {
  if (!auto) return;
  if (!attachProject) {
    throw new Error(
      ssh
        ? '`--auto` cannot infer a project through `host --ssh`; run `clausroom host --auto` in the remote project shell instead.'
        : '`--auto` requires the current project; remove `--no-project`.',
    );
  }
  if (agent === 'none') {
    throw new Error('`--auto` requires `--agent codex` or `--agent claude`.');
  }
}

async function startProjectAuto(configPath: string): Promise<ManagedProjectAuto> {
  const cli = currentCliCommand();
  const child = spawn(cli.executable, [...cli.args, 'project-auto', '--config', configPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (!child.stdout) throw new Error('could not capture auto-responder startup output');

  const managed: ManagedProjectAuto = {
    child,
    stopping: false,
    removeForwarding: () => undefined,
  };
  const interrupt = (): void => {
    managed.stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGINT');
  };
  const terminate = (): void => {
    managed.stopping = true;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  managed.removeForwarding = () => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  };

  const lines = readline.createInterface({ input: child.stdout });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('auto responder did not become ready within 20 seconds'));
      }, 20_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        lines.removeListener('line', onLine);
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(new Error(`could not start auto responder: ${err.message}`));
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        cleanup();
        reject(
          new Error(
            `auto responder exited before becoming ready${signal ? ` (${signal})` : ` (code ${code ?? 1})`}`,
          ),
        );
      };
      const onLine = (line: string): void => {
        if (line === 'CLAUSROOM_PROJECT_AUTO_READY') {
          cleanup();
          resolve();
        } else {
          process.stdout.write(`${line}\n`);
        }
      };
      child.once('error', onError);
      child.once('exit', onExit);
      lines.on('line', onLine);
    });
  } catch (err) {
    managed.stopping = true;
    managed.removeForwarding();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw err;
  } finally {
    lines.close();
  }

  child.once('exit', (code, signal) => {
    if (!managed.stopping) {
      process.stderr.write(
        `[clausroom] Auto responder stopped unexpectedly${signal ? ` (${signal})` : ` (code ${code ?? 1})`}.\n`,
      );
    }
  });
  return managed;
}

async function stopProjectAuto(managed: ManagedProjectAuto | undefined): Promise<void> {
  if (!managed) return;
  const signalAlreadyForwarded = managed.stopping;
  managed.stopping = true;
  managed.removeForwarding();
  const { child } = managed;
  if (child.exitCode !== null || child.signalCode !== null) return;

  if (!signalAlreadyForwarded) child.kill('SIGTERM');
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, 10_000);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
  if (!exited && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

export async function runHostCommand(options: HostCommandOptions): Promise<void> {
  const attachProject = options.project !== false && !options.ssh;
  const agent = options.agent ?? 'codex';
  validateAutoRequest(options.auto, attachProject, agent, Boolean(options.ssh));
  if (attachProject) await resolveProjectRoot();
  const serverPort = validatePort(options.serverPort, 3000, '--server-port');
  const localPort = validatePort(options.localPort, 43000, '--local-port');
  const connectionId = randomBytes(18).toString('base64url');
  let stateWritten = false;
  let projectAuto: ManagedProjectAuto | undefined;
  let child: ChildProcess;
  let localServerUrl: string | undefined;

  const upArgs = ['up', '--peer', '--no-open', '--non-interactive'];
  if (options.stun === false) upArgs.push('--peer-no-stun');
  if (options.roomName) upArgs.push('--room-name', options.roomName);
  if (options.hostName) upArgs.push('--student-name', options.hostName);
  if (options.guestName) upArgs.push('--teacher-name', options.guestName);

  if (options.ssh) {
    validateSshTarget(options.ssh);
    const remoteDir = remoteDirectoryCommand(options.remoteDir ?? '~/StanfordMSL/clausroom');
    const setup = options.skipSetup
      ? ''
      : 'npm install && npm run build && npm install -g ./apps/bridge && ';
    const remoteCommand =
      `cd -- ${remoteDir} && ${setup}` +
      `env CLAUSROOM_CLI_CONTEXT=1 AGENT_ROOM_PORT=${serverPort} ` +
      `npm run up -- ${upArgs.slice(1).map(shellQuote).join(' ')}`;
    localServerUrl = `http://127.0.0.1:${localPort}`;
    child = spawn(
      'ssh',
      [
        '-o',
        'ExitOnForwardFailure=yes',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${serverPort}`,
        options.ssh,
        remoteCommand,
      ],
      { stdio: ['inherit', 'pipe', 'inherit'] },
    );
  } else {
    const repo = await findLocalRepo(options.repo);
    if (!options.skipSetup) {
      const install = spawn('npm', ['install'], { cwd: repo, stdio: 'inherit' });
      if ((await waitForChild(install)) !== 0) throw new Error('npm install failed');
      const build = spawn('npm', ['run', 'build'], { cwd: repo, stdio: 'inherit' });
      if ((await waitForChild(build)) !== 0) throw new Error('npm run build failed');
    }
    child = spawn(process.execPath, [path.join(repo, 'scripts', 'host-setup.mjs'), ...upArgs], {
      cwd: repo,
      env: {
        ...process.env,
        CLAUSROOM_CLI_CONTEXT: '1',
        AGENT_ROOM_PORT: String(serverPort),
      },
      stdio: ['inherit', 'pipe', 'inherit'],
    });
  }

  if (!child.stdout) throw new Error('could not capture host output');
  const removeForwarding = installChildForwarding(child);
  let contextWork = Promise.resolve();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const prefix = 'CLAUSROOM_HOST_CONTEXT ';
    if (!line.startsWith(prefix)) {
      process.stdout.write(`${line}\n`);
      return;
    }
    contextWork = contextWork
      .then(async () => {
        const context = decodeHostContext(line.slice(prefix.length));
        const serverUrl = localServerUrl ?? context.serverUrl;
        const active: ActiveRoom = {
          v: STATE_VERSION,
          connectionId,
          pid: process.pid,
          role: 'host',
          serverUrl,
          roomId: context.roomId,
          bridgeToken: context.bridgeToken,
          humanName: context.humanName,
          agentName: context.agentName,
          createdAt: new Date().toISOString(),
        };
        await writeActiveRoom(active);
        stateWritten = true;
        if (attachProject) {
          const configPath = await runProjectCommand({
            agent,
            allowAgentUploads: options.allowAgentUploads,
            auto: options.auto,
          });
          if (options.auto) projectAuto = await startProjectAuto(configPath);
        }
        const browserUrl = sessionUrl(serverUrl, context.sessionToken);
        const opened = options.open === false ? false : await openBrowser(browserUrl);
        process.stderr.write(
          attachProject
            ? `[clausroom] Host browser is ${serverUrl}; the current project is attached${options.auto ? ` and ${agent} auto-response is running` : ''}.\n`
            : `[clausroom] Host browser is ${serverUrl}; project attachment was skipped.\n`,
        );
        if (!opened) {
          process.stderr.write(
            `[clausroom] Open this private browser URL (do not share): ${browserUrl}\n`,
          );
        }
      })
      .catch((err) => {
        child.kill('SIGTERM');
        throw err;
      });
  });

  try {
    const code = await waitForChild(child);
    await contextWork;
    if (code !== 0 && code !== 128 && code !== 130) {
      throw new Error(`host process exited with code ${code}`);
    }
  } finally {
    removeForwarding();
    lines.close();
    await stopProjectAuto(projectAuto);
    if (stateWritten) await clearActiveRoom(connectionId);
  }
}

async function exchangeInvite(localUrl: string, inviteToken: string): Promise<string> {
  const response = await fetch(`${localUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite_token: inviteToken }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => null)) as { session_token?: unknown } | null;
  if (!response.ok) {
    throw new Error(`room invite exchange failed with HTTP ${response.status}`);
  }
  if (!body || typeof body.session_token !== 'string' || !/^arst_[0-9a-f]{32}$/.test(body.session_token)) {
    throw new Error('room invite exchange returned an invalid session');
  }
  return body.session_token;
}

export async function runConnectCommand(options: ConnectCommandOptions): Promise<void> {
  const attachProject = options.project !== false;
  const agent = options.agent ?? 'codex';
  validateAutoRequest(options.auto, attachProject, agent);
  if (attachProject) await resolveProjectRoot();
  const connectionId = randomBytes(18).toString('base64url');
  let stateWritten = false;
  let projectAuto: ManagedProjectAuto | undefined;
  try {
    await runPeerJoin({
      offerFile: options.offerFile,
      listenPort: options.listenPort,
      stunUrls: options.stunUrls,
      onReady: async ({ localUrl, roomInvite }) => {
        if (!roomInvite) {
          throw new Error(
            'This is a legacy peer offer without room credentials. Use `clausroom peer join` for that offer.',
          );
        }
        const active: ActiveRoom = {
          v: STATE_VERSION,
          connectionId,
          pid: process.pid,
          role: 'guest',
          serverUrl: localUrl,
          roomId: roomInvite.roomId,
          bridgeToken: roomInvite.bridgeToken,
          humanName: roomInvite.humanName,
          agentName: roomInvite.agentName,
          createdAt: new Date().toISOString(),
        };
        await writeActiveRoom(active);
        stateWritten = true;
        const token = await exchangeInvite(localUrl, roomInvite.inviteToken);
        if (attachProject) {
          const configPath = await runProjectCommand({
            agent,
            allowAgentUploads: options.allowAgentUploads,
            auto: options.auto,
          });
          if (options.auto) projectAuto = await startProjectAuto(configPath);
        }
        const browserUrl = sessionUrl(localUrl, token);
        const opened = options.open === false ? false : await openBrowser(browserUrl);
        process.stderr.write(
          attachProject
            ? `[clausroom] Connected. Browser URL: ${localUrl}; the current project is attached${options.auto ? ` and ${agent} auto-response is running` : ''}.\n`
            : `[clausroom] Connected. Browser URL: ${localUrl}; project attachment was skipped.\n`,
        );
        if (!opened) {
          process.stderr.write(
            `[clausroom] Open this private browser URL (do not share): ${browserUrl}\n`,
          );
        }
      },
    });
  } finally {
    await stopProjectAuto(projectAuto);
    if (stateWritten) await clearActiveRoom(connectionId);
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function projectConfig(
  active: ActiveRoom,
  root: string,
  allowAgentUploads: boolean,
  autoAgent?: Exclude<ProjectCommandOptions['agent'], 'none'>,
): string {
  return `# Generated by \`clausroom host\`, \`clausroom connect\`, or \`clausroom project\`. Contains no credential.
[identity]
human_name = ${tomlString(active.humanName)}
agent_name = ${tomlString(active.agentName)}
bridge_name = ${tomlString(`${active.agentName} Bridge`)}

[room]
server_url = ${tomlString(active.serverUrl)}
room_id = ${tomlString(active.roomId)}
token_env = ${tomlString(TOKEN_ENV)}

[policy]
read_only_default = true
allow_agent_to_send_text = true
allow_agent_to_upload_files = ${allowAgentUploads}
require_human_approval_for_uploads = true
max_upload_bytes_without_approval = 1048576
max_upload_bytes_absolute = 26214400

[filesystem]
roots = [${tomlString(root)}]
deny_globs = []
${
  autoAgent
    ? `
[auto]
engine = ${tomlString(autoAgent)}
workdir = ${tomlString(root)}
allowed_tools = ["Read", "Grep", "Glob"]
max_turns = 25
timeout_seconds = 300
max_context_messages = 30
respond_to = "addressed"
`
    : ''
}
`;
}

async function runCli(command: string, args: string[], cwd: string, allowFailure = false): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: allowFailure ? 'ignore' : 'inherit' });
  const code = await waitForChild(child);
  if (code !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.slice(0, 3).join(' ')} failed with exit code ${code}`);
  }
}

function currentCliCommand(): { executable: string; args: string[] } {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  if (!entry || entry.endsWith('.ts')) {
    throw new Error('`clausroom project` must be run from the built or globally installed Clausroom CLI.');
  }
  return { executable: process.execPath, args: [entry] };
}

export async function runProjectCommand(options: ProjectCommandOptions): Promise<string> {
  if (options.auto && options.agent === 'none') {
    throw new Error('`--auto` requires `--agent codex` or `--agent claude`.');
  }
  const active = await readActiveRoom();
  const root = await resolveProjectRoot();
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 20);
  const projectsDir = path.join(await ensureStateDir(), 'projects');
  await fsp.mkdir(projectsDir, { recursive: true, mode: 0o700 });
  const projectsStat = await fsp.lstat(projectsDir);
  if (!projectsStat.isDirectory() || projectsStat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Clausroom project-config directory: ${projectsDir}`);
  }
  await fsp.chmod(projectsDir, 0o700);
  const configPath = path.join(projectsDir, `${digest}.toml`);
  await atomicPrivateWrite(
    configPath,
    projectConfig(
      active,
      root,
      Boolean(options.allowAgentUploads),
      options.auto ? options.agent as Exclude<ProjectCommandOptions['agent'], 'none'> : undefined,
    ),
  );

  if (options.agent !== 'none') {
    const cli = currentCliCommand();
    const mcpCommand = [...cli.args, 'project-mcp', '--config', configPath];
    if (options.agent === 'codex') {
      await runCli('codex', ['mcp', 'remove', 'clausroom'], root, true);
      await runCli('codex', ['mcp', 'add', 'clausroom', '--', cli.executable, ...mcpCommand], root);
    } else {
      await runCli('claude', ['mcp', 'remove', '--scope', 'local', 'clausroom'], root, true);
      await runCli(
        'claude',
        ['mcp', 'add', '--scope', 'local', '--transport', 'stdio', 'clausroom', '--', cli.executable, ...mcpCommand],
        root,
      );
    }
  }

  process.stdout.write(`Clausroom project attached: ${root}\n`);
  process.stdout.write(`Filesystem access is limited to that directory; agent uploads are ${options.allowAgentUploads ? 'approval-gated' : 'disabled'}.\n`);
  if (options.auto) {
    process.stdout.write(`${options.agent} auto-response configured with read-only tools.\n`);
  }
  return configPath;
}

async function resolveProjectRoot(): Promise<string> {
  const root = await fsp.realpath(process.cwd());
  const home = await fsp.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  if (root === path.parse(root).root || root === home) {
    throw new Error('Refusing to expose an entire filesystem or home directory. Run this from the specific project directory.');
  }
  return root;
}

export async function runProjectMcp(configPath: string | undefined): Promise<void> {
  if (!configPath) throw new Error('project-mcp requires --config');
  const active = await readActiveRoom();
  const config = loadConfig(configPath);
  if (config.room.room_id !== active.roomId || config.room.server_url !== active.serverUrl) {
    throw new Error(
      'This project configuration belongs to a different Clausroom connection. Run `clausroom project` again.',
    );
  }
  process.env[TOKEN_ENV] = active.bridgeToken;
  await runMcpServer(configPath);
}

export async function runProjectAuto(configPath: string | undefined): Promise<void> {
  if (!configPath) throw new Error('project-auto requires --config');
  const active = await readActiveRoom();
  const config = loadConfig(configPath);
  if (config.room.room_id !== active.roomId || config.room.server_url !== active.serverUrl) {
    throw new Error(
      'This project configuration belongs to a different Clausroom connection. Start host/connect again.',
    );
  }
  process.env[TOKEN_ENV] = active.bridgeToken;
  const { runAutoResponder } = await import('./auto.js');
  await runAutoResponder(configPath, () => {
    process.stdout.write('CLAUSROOM_PROJECT_AUTO_READY\n');
  });
}
