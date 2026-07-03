#!/usr/bin/env node
/**
 * clausroom-bridge CLI.
 *
 * Subcommands:
 *   mcp   --config <path>   Run the stdio MCP server for the local coding agent.
 *                           stdout is reserved for the MCP protocol; all logs
 *                           go to stderr.
 *   check --config <path>   Connectivity/config test: /healthz, authenticated
 *                           GET room, print a summary, exit 0/1.
 *   auto  --config <path>   Autonomous responder: watch the room and answer
 *                           messages addressed to this agent by driving a
 *                           local engine (claude | codex [EXPERIMENTAL] |
 *                           custom) per the [auto] section of bridge.toml.
 */

import { Command } from 'commander';
import { RoomClient } from './client.js';
import {
  ConfigError,
  DEFAULT_CONFIG_PATH,
  loadConfig,
  resolveToken,
} from './config.js';
import { policySummary } from './policy.js';
import { resolveDownloadsDir } from './state.js';

async function runCheck(configPath: string | undefined): Promise<number> {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  const fail = (line: string) => process.stderr.write(`${line}\n`);

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
  out(`config:    OK (${configPath ?? DEFAULT_CONFIG_PATH})`);
  out(`server:    ${cfg.room.server_url}`);
  out(`room:      ${cfg.room.room_id}`);

  let token: string;
  try {
    const resolved = resolveToken(cfg);
    token = resolved.token;
    if (resolved.warning) fail(resolved.warning);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    return 1;
  }
  out(`token:     OK (from $${cfg.room.token_env})`);

  const client = new RoomClient(cfg.room.server_url, cfg.room.room_id, token);

  try {
    const ok = await client.healthz();
    if (!ok) {
      fail('healthz:   server responded but reported ok=false');
      return 1;
    }
    out('healthz:   OK');
  } catch (err) {
    fail(`healthz:   FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const me = await client.me();
    out(`identity:  ${me.display_name} (${me.id}, kind ${me.kind})`);
  } catch (err) {
    fail(`identity:  FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    const info = await client.getRoom();
    out(
      `room:      OK — "${info.room.name}", ${info.participants.length} participant(s), ` +
        `agents_paused=${info.room.agents_paused}, my_role=${info.my_role}`,
    );
  } catch (err) {
    fail(`room:      FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  out(`policy:    ${policySummary(cfg)}`);
  out(`downloads: ${resolveDownloadsDir(cfg)}`);
  out('All checks passed.');
  return 0;
}

const program = new Command();

program
  .name('clausroom-bridge')
  .description(
    'clausroom local bridge: outbound-only connection to the room server, ' +
      'exposing MCP tools (stdio) to a local coding agent, plus an autonomous ' +
      'auto-responder (`auto`) that drives a local engine.',
  )
  .version('0.1.0');

program
  .command('mcp')
  .description(
    'Run the stdio MCP server for the local coding agent. stdout is reserved for MCP; logs go to stderr.',
  )
  .option('-c, --config <path>', `path to bridge.toml (default: ${DEFAULT_CONFIG_PATH})`)
  .action(async (opts: { config?: string }) => {
    try {
      const { runMcpServer } = await import('./mcp.js');
      await runMcpServer(opts.config);
    } catch (err) {
      process.stderr.write(
        `${err instanceof ConfigError ? err.message : `bridge startup failed: ${err instanceof Error ? err.message : String(err)}`}\n`,
      );
      process.exit(1);
    }
  });

program
  .command('check')
  .description('Test connectivity and config: /healthz, authenticated GET room, print a summary.')
  .option('-c, --config <path>', `path to bridge.toml (default: ${DEFAULT_CONFIG_PATH})`)
  .action(async (opts: { config?: string }) => {
    const code = await runCheck(opts.config);
    process.exit(code);
  });

program
  .command('auto')
  .description(
    'Run the autonomous responder: watch the room and answer messages addressed to this agent by ' +
      'driving a local engine per the [auto] section of bridge.toml. ' +
      'Engines: claude (Claude Code CLI), codex (EXPERIMENTAL — untested interface), ' +
      'custom (your own argv command; prompt on stdin, reply on stdout). ' +
      'Room content is untrusted input to the engine; replies pass local policy and the ' +
      "server's pause/turn/rate limits. Logs go to stderr; stop with Ctrl-C.",
  )
  .option('-c, --config <path>', `path to bridge.toml (default: ${DEFAULT_CONFIG_PATH})`)
  .action(async (opts: { config?: string }) => {
    try {
      const { runAutoResponder } = await import('./auto.js');
      await runAutoResponder(opts.config);
    } catch (err) {
      process.stderr.write(
        `${err instanceof ConfigError ? err.message : `auto responder failed: ${err instanceof Error ? err.message : String(err)}`}\n`,
      );
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
