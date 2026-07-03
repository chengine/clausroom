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

/** argv for the given engine (exported for the stderr banner / debugging). */
export function engineArgv(auto: AutoConfig): { command: string; args: string[] } {
  switch (auto.engine) {
    case 'claude': {
      const args = [
        '-p',
        '--output-format',
        'json',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        auto.allowed_tools.join(','),
        '--max-turns',
        String(auto.max_turns),
        ...(auto.model ? ['--model', auto.model] : []),
        ...(auto.bare ? ['--bare'] : []),
        ...(auto.max_budget_usd !== undefined
          ? ['--max-budget-usd', String(auto.max_budget_usd)]
          : []),
        ...auto.extra_args,
      ];
      return { command: 'claude', args };
    }
    case 'codex':
      return {
        command: 'codex',
        args: ['exec', '--sandbox', 'read-only', '--ask-for-approval', 'never', ...auto.extra_args],
      };
    case 'custom':
      // parseAutoConfig guarantees custom_command is non-empty here.
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
  },
): Promise<EngineOutcome> {
  const { command, args } = engineArgv(auto);

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
