/**
 * Primitives with no knowledge of clausroom, shared by more than one module.
 * Everything the CLI prints for a human goes to stderr: stdout is reserved for
 * the MCP protocol, the peer offer/answer codes, and readiness lines.
 */
import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    timer.unref();
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
