#!/usr/bin/env node
/**
 * clausroom — a private chatroom for two people and their coding agents.
 *
 *   clausroom host      start a room and offer a direct connection
 *   clausroom connect   take an offer and join the room
 *   clausroom project   re-point your agent at the running room
 *   clausroom check     validate the config and the running room
 *
 * Every choice lives in clausroom.toml. The only flags are the ones that
 * describe this one invocation, so there is never a question of which wins.
 */
import { Command } from 'commander';
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

program
  .command('host')
  .description('Start a room here and print an offer to send to the other person.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: { config?: string; open?: boolean }) => {
    await attempt('host', async () => {
      const { runHost } = await import('./launch.js');
      await runHost({
        ...(configOf(opts.config) ? { config: configOf(opts.config) } : {}),
        ...(opts.open === false ? { open: false } : {}),
      });
    });
  });

program
  .command('connect')
  .description('Join a room using the offer the host sent you.')
  .option('-c, --config <path>', 'clausroom.toml to use')
  .option('--no-open', 'do not open the browser')
  .action(async (opts: { config?: string; open?: boolean }) => {
    await attempt('connect', async () => {
      const { runConnect } = await import('./launch.js');
      await runConnect({
        ...(configOf(opts.config) ? { config: configOf(opts.config) } : {}),
        ...(opts.open === false ? { open: false } : {}),
      });
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
  .action(async (opts: { config?: string }) => {
    await attempt('auto-reply', async () => {
      const { AUTO_READY, runAuto } = await import('./auto.js');
      await runAuto(configOf(opts.config), () => process.stdout.write(`${AUTO_READY}\n`));
    });
  });

program.parseAsync(process.argv).catch((err) => {
  log(errorText(err));
  process.exit(1);
});
