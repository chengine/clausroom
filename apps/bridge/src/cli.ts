#!/usr/bin/env node
/**
 * clausroom — a private chatroom for two people and their coding agents.
 *
 *   clausroom host      start a room for this project
 *   clausroom connect   join a room from this project
 *   clausroom project   re-point your agent at the running room
 *   clausroom check     validate the config and the running room
 *
 * Every choice lives in clausroom.toml. The only flags are the ones that
 * describe this one invocation, so there is never a question of which wins.
 */
import { Command, InvalidArgumentError } from 'commander';
import { ConfigError } from './config.js';
import { log, message as errorText } from './util.js';

/** Run a command, turning any failure into one readable line and exit code 1. */
async function attempt(what: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    log(err instanceof ConfigError ? err.message : `${what} failed: ${errorText(err)}`);
    process.exitCode = 1;
  }
}

const program = new Command()
  .name('clausroom')
  .description(
    'A private chatroom for two people and their coding agents, over a direct ' +
      'encrypted connection. Neither machine, repository, nor port is shared.',
  )
  .version('0.2.0')
  .option('-c, --config <path>', 'clausroom.toml to use (default: ./clausroom.toml)');

/** --config is accepted before or after the subcommand. */
const configOf = (local: string | undefined): string | undefined =>
  local ?? (program.opts().config as string | undefined);

const port = (value: string): number => {
  if (!/^\d{1,5}$/.test(value)) throw new InvalidArgumentError('must be an integer from 1 to 65535');
  const parsed = Number(value);
  if (parsed < 1 || parsed > 65535) {
    throw new InvalidArgumentError('must be an integer from 1 to 65535');
  }
  return parsed;
};

const agent = (value: string): 'claude' | 'codex' | 'none' => {
  if (value === 'claude' || value === 'codex' || value === 'none') return value;
  throw new InvalidArgumentError('must be claude, codex, or none');
};

interface StartOptions {
  config?: string;
  open?: boolean;
  agent?: 'claude' | 'codex' | 'none';
  auto?: boolean;
}

const startOptions = (opts: StartOptions): StartOptions => {
  const config = configOf(opts.config);
  return {
    ...(config ? { config } : {}),
    ...(opts.open === false ? { open: false } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.auto ? { auto: true } : {}),
  };
};

program
  .command('host')
  .description('Start a room here; the browser displays the private invite.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .option('--agent <agent>', 'coding agent: claude, codex, or none', agent)
  .option('--auto', 'let the selected agent answer addressed messages')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: StartOptions) => {
    await attempt('host', async () => {
      const { runHost } = await import('./launch.js');
      await runHost(startOptions(opts));
    });
  });

program
  .command('connect')
  .description('Open the browser that accepts a host invite and joins the room.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .option('--agent <agent>', 'coding agent: claude, codex, or none', agent)
  .option('--auto', 'let the selected agent answer addressed messages')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: StartOptions) => {
    await attempt('connect', async () => {
      const { runConnect } = await import('./launch.js');
      await runConnect(startOptions(opts));
    });
  });

program
  .command('project')
  .description('Re-register your coding agent against the running room.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .action(async (opts: { config?: string }) => {
    await attempt('project', async () => {
      const { runProject } = await import('./launch.js');
      const config = configOf(opts.config);
      await runProject(config ? { config } : {});
    });
  });

program
  .command('check')
  .description('Validate clausroom.toml and, if a room is running, reach it.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .action(async (opts: { config?: string }) => {
    const { runCheck } = await import('./launch.js');
    const config = configOf(opts.config);
    try {
      process.exit(await runCheck(config ? { config } : {}));
    } catch (err) {
      log(err instanceof ConfigError ? err.message : `check failed: ${errorText(err)}`);
      process.exit(1);
    }
  });

const ssh = program
  .command('ssh')
  .description('Manage a loopback-only browser forward to a Clausroom machine.');

ssh
  .command('setup')
  .description('Add Clausroom to an existing SSH destination and start it now.')
  .argument('<destination>', 'existing SSH hostname or user@hostname')
  .option('--ssh-port <port>', 'SSH server port', port, 22)
  .requiredOption('--clausroom-port <port>', 'loopback port Clausroom listens on', port)
  .action(async (destination: string, opts: { sshPort: number; clausroomPort: number }) => {
    await attempt('SSH forward', async () => {
      const { setupSshForward } = await import('./ssh.js');
      await setupSshForward(destination, opts.sshPort, opts.clausroomPort);
    });
  });

program
  .command('mcp', { hidden: true })
  .description('Serve the room tools to a coding agent over stdio. Started by the agent.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .action(async (opts: { config?: string }) => {
    await attempt('the room tools', async () => {
      const { runMcp } = await import('./mcp.js');
      await runMcp(configOf(opts.config));
    });
  });

program
  .command('auto', { hidden: true })
  .description('Answer the room with the local coding agent. Started by host/connect.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .option('--agent <agent>', 'coding agent selected by the launcher', agent)
  .action(async (opts: { config?: string; agent?: 'claude' | 'codex' | 'none' }) => {
    await attempt('auto-reply', async () => {
      const { AUTO_READY, runAuto } = await import('./auto.js');
      await runAuto(
        configOf(opts.config),
        () => process.stdout.write(`${AUTO_READY}\n`),
        opts.agent,
      );
    });
  });

program.parseAsync(process.argv).catch((err) => {
  log(errorText(err));
  process.exit(1);
});
