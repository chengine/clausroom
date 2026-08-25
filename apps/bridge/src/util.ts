/**
 * Primitives with no knowledge of clausroom, shared by more than one module.
 * Everything the CLI prints for a human goes to stderr; stdout is reserved for
 * machine protocols and readiness lines.
 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

/** What a remote process can actually learn about its enclosing SSH session. */
export interface SshSession {
  source: 'connection' | 'client' | 'tty';
  clientAddress: string | null;
  serverAddress: string | null;
  serverPort: number | null;
}

const sshPort = (raw: string | undefined): number | null => {
  if (!raw || !/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
};

/**
 * Detect SSH without guessing from DISPLAY or the terminal type. SSH_CONNECTION
 * is the useful form: client-ip client-port server-ip server-port. The fallbacks
 * establish only that this is SSH; they cannot recover a destination address.
 */
export function detectSshSession(env: NodeJS.ProcessEnv = process.env): SshSession | null {
  if (env.SSH_CONNECTION) {
    const [clientAddress, _clientPort, serverAddress, serverPort] = env.SSH_CONNECTION
      .trim()
      .split(/\s+/);
    return {
      source: 'connection',
      clientAddress: clientAddress || null,
      serverAddress: serverAddress || null,
      serverPort: sshPort(serverPort),
    };
  }
  if (env.SSH_CLIENT) {
    const [clientAddress, _clientPort, serverPort] = env.SSH_CLIENT.trim().split(/\s+/);
    return {
      source: 'client',
      clientAddress: clientAddress || null,
      serverAddress: null,
      serverPort: sshPort(serverPort),
    };
  }
  return env.SSH_TTY
    ? {
        source: 'tty',
        clientAddress: null,
        serverAddress: null,
        serverPort: null,
      }
    : null;
}

export function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Expand a leading `~` to the home directory. */
export function expandHome(target: string): string {
  return target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    ? path.join(os.homedir(), target.slice(1))
    : target;
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Run a command to completion, returning its exit code (128 if signalled). */
export function run(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: StdioOptions } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
  });
}

/** Forward our own SIGINT/SIGTERM to a child; returns a detach function. */
export function forwardSignals(child: ChildProcess): () => void {
  const relay = (signal: NodeJS.Signals) => () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const onInt = relay('SIGINT');
  const onTerm = relay('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return () => {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
  };
}

/** Open a URL in the desktop browser. Returns false if nothing could open it. */
export async function openBrowser(url: string): Promise<boolean> {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    const child = spawn(command as string, args as string[], { stdio: 'ignore' });
    const settle = (opened: boolean) => {
      clearTimeout(timer);
      resolve(opened);
    };
    const timer = setTimeout(() => {
      child.unref();
      settle(false);
    }, 10_000);
    child.once('error', () => settle(false));
    child.once('exit', (code) => settle(code === 0));
  });
}
