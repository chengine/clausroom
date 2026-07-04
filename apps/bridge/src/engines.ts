/**
 * Engine adapters for `clausroom-bridge auto` (contract §13 [auto], Milestone 5).
 *
 * Three engines:
 *   - claude:  `claude -p --output-format json …` — headless Claude Code. The
 *              composed prompt goes to stdin (avoids argv length limits); the
 *              JSON printed to stdout carries the reply in its `result` field
 *              plus run metadata (total_cost_usd, num_turns, permission_denials)
 *              that we log to stderr.
 *   - codex:   `codex exec --sandbox read-only --ask-for-approval never` —
 *              EXPERIMENTAL: coded from the documented interface, not verified
 *              on this machine. Prompt on stdin, plain-text reply on stdout.
 *   - custom:  any argv array from auto.custom_command, spawned directly
 *              (NEVER through a shell). Prompt on stdin, reply on stdout.
 *              This is also the engine CI can exercise hermetically.
 *
 * All engines share: cwd = validated workdir, wall-clock timeout (SIGTERM then
 * SIGKILL, delivered to the engine's whole process group on POSIX), a capped
 * stdout buffer, and an environment scrubbed of the bridge token so a
 * prompt-injected engine cannot exfiltrate room credentials.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { AutoConfig } from './config.js';

/** How an engine run ended, from the caller's point of view. */
export type EngineOutcome =
  /** Post `reply` as the agent_answer body (confidence still to be extracted). */
  | { kind: 'reply'; reply: string }
  /** Post a short apologetic agent_answer ("my engine failed: <reason>"). */
  | { kind: 'failure'; reason: string }
  /** Timed out or aborted: the run was killed and NO reply is posted (contract §13). */
  | { kind: 'timeout' };

/**
 * Grace between SIGTERM and SIGKILL when a run times out or is aborted.
 * Exported so the auto daemon's shutdown can outlive the escalation timer
 * (exiting earlier would orphan a SIGTERM-ignoring engine child).
 */
export const KILL_GRACE_MS = 5_000;
/**
 * After the child's 'exit' event, how long to wait for 'close' (stdio pipes
 * drained) before settling anyway. A descendant that inherited our pipes can
 * hold them open forever after the engine itself died; without this grace the
 * runProcess promise would never settle and the daemon would wedge.
 */
const EXIT_FLUSH_GRACE_MS = 1_000;
/** Cap on captured stdout/stderr so a runaway engine cannot exhaust memory. */
const OUTPUT_CAP_BYTES = 16 * 1024 * 1024;

/**
 * Shape of `claude -p --output-format json` output. Validated leniently — the
 * CLI is external input, and unknown extra fields must never break the daemon.
 */
const ClaudeJsonOutputSchema = z
  .object({
    result: z.string().optional(),
    is_error: z.boolean().optional(),
    subtype: z.string().optional(),
    total_cost_usd: z.number().optional(),
    num_turns: z.number().int().optional(),
    permission_denials: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface ProcessResult {
  status: 'exit' | 'timeout' | 'spawn-error';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errorMessage?: string;
}

/**
 * Spawn `command` with `args` (argv array — never a shell), write `input` to
 * stdin, and collect stdout/stderr until exit, timeout, or abort. Timeout and
 * abort both kill the child (SIGTERM, then SIGKILL after a grace period).
 */
function runProcess(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    input: string;
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
  },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    // StringDecoder keeps multibyte UTF-8 sequences that straddle pipe-chunk
    // boundaries intact (per-chunk Buffer#toString would emit U+FFFD there).
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    // detached on POSIX gives the engine its own process group, so kills reach
    // its descendants too — a background helper spawned by the engine would
    // otherwise survive the kill and keep running unsupervised.
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });

    /** Signal the child's whole process group (POSIX); fall back to the child. */
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && typeof child.pid === 'number') {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };

    /** SIGTERM now, SIGKILL after the grace period (timeout and abort paths). */
    const killWithEscalation = (): void => {
      killTree('SIGTERM');
      const hardKill = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      hardKill.unref();
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      killWithEscalation();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      timedOut = true; // treated like a timeout: killed, no reply posted
      killWithEscalation();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });

    const finish = (result: Omit<ProcessResult, 'stdout' | 'stderr'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      opts.signal.removeEventListener('abort', onAbort);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      resolve({ ...result, stdout, stderr });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > OUTPUT_CAP_BYTES) {
        timedOut = false;
        killTree('SIGKILL');
        finish({
          status: 'spawn-error',
          exitCode: null,
          errorMessage: `engine produced more than ${OUTPUT_CAP_BYTES} bytes of stdout`,
        });
        return;
      }
      stdout += outDecoder.write(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += errDecoder.write(chunk);
    });

    child.on('error', (err) => {
      // Spawn failure (e.g. ENOENT: engine CLI not installed). 'close' may
      // never fire in this case.
      finish({
        status: timedOut ? 'timeout' : 'spawn-error',
        exitCode: null,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    });

    // 'close' (= exit + stdio drained) is the normal settle point; 'exit' plus
    // a short flush grace is the backstop for engines whose descendants keep
    // the inherited pipes open after the engine itself died — without it this
    // promise would never settle and the daemon would stop answering forever.
    child.on('exit', (code) => {
      setTimeout(() => {
        finish({ status: timedOut ? 'timeout' : 'exit', exitCode: code });
      }, EXIT_FLUSH_GRACE_MS);
    });

    child.on('close', (code) => {
      finish({
        status: timedOut ? 'timeout' : 'exit',
        exitCode: code,
      });
    });

    // Prompt goes to stdin (avoids argv length limits). The child may exit
    // before reading it all — EPIPE here must not crash the daemon.
    child.stdin.on('error', () => undefined);
    child.stdin.write(opts.input);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Filesystem confinement (contract §13): the spawned engine must not read file
// CONTENTS or enumerate NAMES outside [filesystem].roots. Two layers:
//   1. Tool permissions (always): scope Read+Grep to the roots via double-slash
//      absolute matchers, deny write/shell/network tools, and deny the
//      name-leaky Glob/LS tools unless an OS sandbox enforces the boundary.
//   2. OS sandbox (defense-in-depth, when bwrap/sandbox-exec is installed):
//      bind only the roots (read-only) + what the engine needs to run.
// ---------------------------------------------------------------------------

/** An available OS sandbox that can confine the engine's filesystem view. */
export interface SandboxInfo {
  kind: 'bwrap' | 'sandbox-exec';
  /** Absolute path to the sandbox binary. */
  bin: string;
}

/** Everything the engine spawn needs beyond the AutoConfig, resolved once. */
export interface EngineLaunch {
  /** Resolved absolute filesystem roots (Read scoping + sandbox binds). */
  roots: string[];
  /** Detected OS sandbox, or null → permission-only confinement. */
  sandbox: SandboxInfo | null;
}

/** Locate an executable on PATH (no shell); returns its absolute path or null. */
function findOnPath(bin: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      return full;
    } catch {
      /* not in this dir */
    }
  }
  return null;
}

/**
 * Detect an OS sandbox for filesystem confinement: bubblewrap (`bwrap`) on
 * Linux, `sandbox-exec` on macOS. Returns null when none is available (the
 * bridge then relies on permission-only confinement + the injected file tree
 * and warns). Best-effort defense-in-depth: the sandbox wrappers are coded from
 * the tools' documented interfaces.
 */
export function detectSandbox(): SandboxInfo | null {
  if (process.platform === 'linux') {
    const bin = findOnPath('bwrap');
    return bin ? { kind: 'bwrap', bin } : null;
  }
  if (process.platform === 'darwin') {
    const bin = findOnPath('sandbox-exec') ?? '/usr/bin/sandbox-exec';
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return { kind: 'sandbox-exec', bin };
    } catch {
      return null;
    }
  }
  return null;
}

/** Tools always denied to the engine: no shell, no writes, no network. */
const ALWAYS_DENIED_TOOLS = [
  'Bash',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
] as const;

/**
 * Name-enumeration tools that cannot be path-scoped by a matcher on this CLI
 * (verified: a `Read(//root/**)` matcher confines Read+Grep but NOT Glob/LS).
 * Denied UNLESS an OS sandbox enforces the filesystem boundary — otherwise they
 * leak file NAMES outside the roots. The bridge injects a bounded file tree so
 * the engine can still discover structure without them.
 */
const NAME_LEAK_TOOLS = ['Glob', 'LS'] as const;

/** Double-slash absolute matcher that confines Read (and Grep) to `root`. */
function rootReadMatcher(root: string): string {
  // '//' + absolute-path-without-leading-slash + '/**'. This form confines both
  // the Read and the Grep tool to the subtree on the claude CLI (verified).
  const abs = root.replace(/\\/g, '/').replace(/^\/+/, '');
  return `Read(//${abs}/**)`;
}

/**
 * Translate the SEMANTIC `allowed_tools` list + resolved roots into concrete
 * claude `--allowedTools` / `--disallowedTools` lists.
 *   - Read/Grep are ALWAYS scoped to the roots (one `Read(//root/**)` per root).
 *     This both grants and CONFINES them; without the matcher, dontAsk would
 *     leave Read/Grep implicitly permitted and UNCONFINED (the security bug).
 *   - Write/shell/network tools are always denied.
 *   - Glob/LS are denied unless a sandbox is active and the operator asked for
 *     them (they cannot be path-scoped).
 */
export function claudeToolArgs(
  allowedTools: readonly string[],
  roots: readonly string[],
  sandboxed: boolean,
): { allowed: string[]; disallowed: string[] } {
  const allowed: string[] = [];
  for (const root of [...new Set(roots)]) allowed.push(rootReadMatcher(root));

  const disallowed: string[] = [...ALWAYS_DENIED_TOOLS];
  const wantsNameTools = allowedTools.some((t) => /^(?:Glob|LS)$/i.test(t));
  if (sandboxed && wantsNameTools) {
    allowed.push(...NAME_LEAK_TOOLS); // sandbox enforces the FS boundary
  } else {
    disallowed.push(...NAME_LEAK_TOOLS);
  }
  return { allowed, disallowed };
}

/**
 * Wrap `[command, ...args]` in the OS sandbox so only `roots` are readable and
 * everything the engine needs to run is bound in. Returns the wrapped argv.
 * Best-effort defense-in-depth (untested on this machine); if the wrapper
 * mis-binds, the engine simply fails to spawn and the daemon posts an
 * apologetic reply and keeps running.
 */
export function wrapWithSandbox(
  sandbox: SandboxInfo,
  roots: readonly string[],
  workdir: string,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  const home = os.homedir();
  const nodeDir = path.dirname(process.execPath);

  if (sandbox.kind === 'bwrap') {
    const bwrap: string[] = [
      '--die-with-parent',
      '--unshare-user',
      '--unshare-ipc',
      '--unshare-uts',
      // network is intentionally SHARED (not unshared): the engine calls the
      // model API. Filesystem — not the network — is the confinement boundary.
      '--proc', '/proc',
      '--dev', '/dev',
      '--tmpfs', '/tmp',
      // System runtime, read-only (needed for node's shared libraries + TLS).
      '--ro-bind', '/usr', '/usr',
      '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/sbin', '/sbin',
      '--ro-bind-try', '/lib', '/lib',
      '--ro-bind-try', '/lib64', '/lib64',
      // CA certs + resolver + uid/gid lookup, read-only (nothing project-secret).
      '--ro-bind-try', '/etc/ssl', '/etc/ssl',
      '--ro-bind-try', '/etc/ca-certificates', '/etc/ca-certificates',
      '--ro-bind-try', '/etc/pki', '/etc/pki',
      '--ro-bind-try', '/etc/resolv.conf', '/etc/resolv.conf',
      '--ro-bind-try', '/etc/hosts', '/etc/hosts',
      '--ro-bind-try', '/etc/nsswitch.conf', '/etc/nsswitch.conf',
      '--ro-bind-try', '/etc/passwd', '/etc/passwd',
      '--ro-bind-try', '/etc/group', '/etc/group',
      // The node/engine binaries, read-only.
      '--ro-bind-try', nodeDir, nodeDir,
    ];
    // Claude auth/session dirs: writable so headless runs can persist state.
    bwrap.push('--bind-try', path.join(home, '.claude'), path.join(home, '.claude'));
    bwrap.push('--bind-try', path.join(home, '.config', 'claude'), path.join(home, '.config', 'claude'));
    // The engine's own install tree (npm/pnpm global etc.), read-only.
    bwrap.push('--ro-bind-try', path.join(home, '.local'), path.join(home, '.local'));
    bwrap.push('--ro-bind-try', path.join(home, '.npm'), path.join(home, '.npm'));
    // The project roots, READ-ONLY — the confinement boundary.
    for (const root of [...new Set(roots)]) bwrap.push('--ro-bind', root, root);
    bwrap.push('--chdir', workdir, '--', command, ...args);
    return { command: sandbox.bin, args: bwrap };
  }

  // darwin: sandbox-exec with a generated SBPL profile (deprecated but present
  // on stock macOS). Default-deny file reads; allow only roots + system paths.
  const subpaths = [
    '/usr', '/System', '/Library', '/bin', '/sbin', '/private/etc', '/private/var',
    nodeDir,
    path.join(home, '.claude'),
    path.join(home, '.config', 'claude'),
    path.join(home, '.local'),
    ...new Set(roots),
  ];
  const sbpl = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach*)',
    '(allow network*)',
    '(allow file-read-metadata)',
    '(allow file-write* (subpath "/private/tmp") (subpath "/private/var/tmp") ' +
      `(subpath "${path.join(home, '.claude')}") (subpath "${path.join(home, '.config', 'claude')}"))`,
    `(allow file-read* ${subpaths.map((p) => `(subpath "${p}")`).join(' ')})`,
  ].join('\n');
  return { command: sandbox.bin, args: ['-p', sbpl, command, ...args] };
}

/** argv for the given engine, with confinement applied (contract §13). */
export function engineArgv(
  auto: AutoConfig,
  launch: EngineLaunch,
): { command: string; args: string[] } {
  switch (auto.engine) {
    case 'claude': {
      const { allowed, disallowed } = claudeToolArgs(
        auto.allowed_tools,
        launch.roots,
        launch.sandbox !== null,
      );
      const args = [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        ...allowed,
        '--disallowedTools',
        ...disallowed,
        '--max-turns',
        String(auto.max_turns),
        ...(auto.model ? ['--model', auto.model] : []),
        ...(auto.bare ? ['--bare'] : []),
        ...(auto.max_budget_usd !== undefined
          ? ['--max-budget-usd', String(auto.max_budget_usd)]
          : []),
        ...auto.extra_args,
      ];
      const base = { command: 'claude', args };
      return launch.sandbox
        ? wrapWithSandbox(launch.sandbox, launch.roots, auto.workdir, base.command, base.args)
        : base;
    }
    case 'codex': {
      // codex already self-sandboxes (--sandbox read-only); the OS sandbox is
      // extra defense-in-depth when present.
      const base = {
        command: 'codex',
        args: ['exec', '--sandbox', 'read-only', '--ask-for-approval', 'never', ...auto.extra_args],
      };
      return launch.sandbox
        ? wrapWithSandbox(launch.sandbox, launch.roots, auto.workdir, base.command, base.args)
        : base;
    }
    case 'custom':
      // parseAutoConfig guarantees custom_command is non-empty here. Containment
      // for a custom engine is the operator's responsibility (documented); we do
      // NOT force it through the OS sandbox (it may not tolerate the bind set).
      return {
        command: auto.custom_command[0] as string,
        args: [...auto.custom_command.slice(1), ...auto.extra_args],
      };
  }
}

/**
 * Run one engine invocation with `prompt` on stdin and return the outcome.
 * Never throws — every failure mode maps to an EngineOutcome so the calling
 * daemon can keep running.
 */
export async function runEngine(
  auto: AutoConfig,
  prompt: string,
  opts: {
    /** stderr logger. */
    log: (line: string) => void;
    /** Aborting kills the run (shutdown); treated like a timeout — no reply. */
    signal: AbortSignal;
    /** Env var names to scrub from the child environment (the bridge token). */
    scrubEnv: string[];
    /** Resolved roots + detected OS sandbox for filesystem confinement (§13). */
    launch: EngineLaunch;
  },
): Promise<EngineOutcome> {
  const { command, args } = engineArgv(auto, opts.launch);

  // The engine must never see the bridge token: room content is untrusted
  // input to it, and a prompt-injected engine with the token could act as us.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of opts.scrubEnv) delete env[name];

  const result = await runProcess(command, args, {
    cwd: auto.workdir,
    input: prompt,
    timeoutMs: auto.timeout_seconds * 1000,
    env,
    signal: opts.signal,
  });

  if (result.status === 'timeout') {
    opts.log(
      `[engine] ${auto.engine} run killed after ${auto.timeout_seconds}s (timeout/shutdown); no reply will be posted.`,
    );
    return { kind: 'timeout' };
  }
  if (result.status === 'spawn-error') {
    let reason = `could not run ${command}: ${result.errorMessage ?? 'unknown spawn error'}`;
    // npm installs on Windows provide only a .cmd shim, which Node refuses to
    // spawn without a shell (and never resolves from the bare name) — point the
    // operator at the fix instead of failing cryptically on every message.
    if (
      process.platform === 'win32' &&
      (auto.engine === 'claude' || auto.engine === 'codex') &&
      /ENOENT|EINVAL/.test(result.errorMessage ?? '')
    ) {
      reason +=
        ` — on Windows, npm installs ${command} as a .cmd shim that cannot be spawned directly; ` +
        `install the native ${command}.exe or see the Windows note in the bridge README`;
    }
    return { kind: 'failure', reason };
  }

  switch (auto.engine) {
    case 'claude':
      return interpretClaudeResult(result, opts.log);
    case 'codex':
    case 'custom': {
      if (result.exitCode !== 0) {
        const errTail = result.stderr.trim().split('\n').at(-1) ?? '';
        return {
          kind: 'failure',
          reason: `exit code ${result.exitCode}${errTail ? ` (${errTail.slice(0, 200)})` : ''}`,
        };
      }
      const reply = result.stdout.trim();
      if (reply.length === 0) return { kind: 'failure', reason: 'empty stdout' };
      return { kind: 'reply', reply };
    }
  }
}

function interpretClaudeResult(
  result: ProcessResult,
  log: (line: string) => void,
): EngineOutcome {
  let parsed: z.infer<typeof ClaudeJsonOutputSchema> | null = null;
  try {
    const data: unknown = JSON.parse(result.stdout);
    const checked = ClaudeJsonOutputSchema.safeParse(data);
    if (checked.success) parsed = checked.data;
  } catch {
    /* non-JSON stdout handled below */
  }

  if (parsed) {
    log(
      `[engine] claude run: cost $${parsed.total_cost_usd ?? '?'}, ` +
        `${parsed.num_turns ?? '?'} turn(s), ` +
        `${parsed.permission_denials?.length ?? 0} permission denial(s)`,
    );
  }

  if (result.exitCode !== 0) {
    return { kind: 'failure', reason: parsed?.subtype ?? `exit code ${result.exitCode}` };
  }
  if (!parsed) {
    return { kind: 'failure', reason: 'unparseable engine output (expected JSON on stdout)' };
  }
  if (parsed.is_error) {
    return { kind: 'failure', reason: parsed.subtype ?? 'unknown_error' };
  }
  const reply = (parsed.result ?? '').trim();
  if (reply.length === 0) {
    return { kind: 'failure', reason: parsed.subtype ?? 'empty result' };
  }
  return { kind: 'reply', reply };
}
