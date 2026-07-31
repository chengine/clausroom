#!/usr/bin/env node
/**
 * clausroom CLI.
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
 *   host / connect           Streamlined direct WebRTC room commands.
 *   project                  Attach only the current directory to the active room.
 *   peer host|join           Low-level direct WebRTC tunnel commands.
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
type ProjectAgent = 'codex' | 'claude' | 'none';

function parseProjectAgent(value: string): ProjectAgent {
  if (value !== 'codex' && value !== 'claude' && value !== 'none') {
    throw new Error('--agent must be codex, claude, or none');
  }
  return value;
}

program
  .name('clausroom')
  .description(
    'clausroom local bridge: MCP room tools, an autonomous responder, and an ' +
      'optional direct-only WebRTC peer transport with loopback boundaries.',
  )
  .version('0.1.0');

program
  .command('host')
  .description(
    'From a project directory, start a secure direct room and attach that project.',
  )
  .option('--ssh <target>', 'run the Clausroom source checkout on [user@]host')
  .option('--repo <path>', 'local Clausroom source checkout')
  .option('--remote-dir <path>', 'remote source checkout (default: ~/StanfordMSL/clausroom)')
  .option('--local-port <port>', 'SSH-forwarded loopback browser port', (value) => Number(value), 43000)
  .option('--server-port <port>', 'host loopback server port', (value) => Number(value), 3000)
  .option('--room-name <name>', 'room display name')
  .option('--host-name <name>', 'host participant display name')
  .option('--guest-name <name>', 'guest participant display name')
  .option('--skip-setup', 'skip dependency install, build, and remote CLI install')
  .option('--agent <agent>', 'coding agent to configure: codex, claude, or none', parseProjectAgent, 'codex')
  .option(
    '--allow-agent-uploads',
    'allow the agent to propose files from this project (human approval is still required)',
  )
  .option('--auto', 'automatically answer room messages with the selected agent using read-only tools')
  .option('--no-project', 'do not attach the current directory as a project')
  .option('--no-stun', 'disable STUN and try host candidates only')
  .option('--no-open', 'do not open the local browser automatically')
  .action(
    async (opts: {
      ssh?: string;
      repo?: string;
      remoteDir?: string;
      localPort?: number;
      serverPort?: number;
      roomName?: string;
      hostName?: string;
      guestName?: string;
      skipSetup?: boolean;
      agent?: ProjectAgent;
      allowAgentUploads?: boolean;
      auto?: boolean;
      project?: boolean;
      stun?: boolean;
      open?: boolean;
    }) => {
      try {
        const { runHostCommand } = await import('./convenience.js');
        await runHostCommand(opts);
      } catch (err) {
        process.stderr.write(`host failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    },
  );

program
  .command('connect')
  .description(
    'From a project directory, connect to a direct room and attach that project.',
  )
  .option('--offer-file <path>', 'read the combined offer from a file')
  .option('--listen-port <port>', 'local-only browser proxy port; 0 chooses a free port', (value) => Number(value), 0)
  .option('--stun <url>', 'STUN discovery URL (repeatable)', (value, previous?: string[]) => [
    ...(previous ?? []),
    value,
  ])
  .option('--no-stun', 'disable STUN and try host candidates only')
  .option('--agent <agent>', 'coding agent to configure: codex, claude, or none', parseProjectAgent, 'codex')
  .option(
    '--allow-agent-uploads',
    'allow the agent to propose files from this project (human approval is still required)',
  )
  .option('--auto', 'automatically answer room messages with the selected agent using read-only tools')
  .option('--no-project', 'do not attach the current directory as a project')
  .option('--no-open', 'do not open the browser automatically')
  .action(
    async (opts: {
      offerFile?: string;
      listenPort?: number;
      stun?: string[] | boolean;
      agent?: ProjectAgent;
      allowAgentUploads?: boolean;
      auto?: boolean;
      project?: boolean;
      open?: boolean;
    }) => {
      try {
        const { runConnectCommand } = await import('./convenience.js');
        await runConnectCommand({
          offerFile: opts.offerFile,
          listenPort: opts.listenPort,
          stunUrls: opts.stun === false ? [] : Array.isArray(opts.stun) ? opts.stun : undefined,
          agent: opts.agent,
          allowAgentUploads: opts.allowAgentUploads,
          auto: opts.auto,
          project: opts.project,
          open: opts.open,
        });
      } catch (err) {
        process.stderr.write(`connect failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    },
  );

program
  .command('project')
  .description(
    'Attach the active room to a coding agent, limiting Clausroom file access to the current directory.',
  )
  .option('--agent <agent>', 'coding agent to configure: codex, claude, or none', parseProjectAgent, 'codex')
  .option(
    '--allow-agent-uploads',
    'allow the agent to propose files from this project (human approval is still required)',
  )
  .action(
    async (opts: {
      agent: ProjectAgent;
      allowAgentUploads?: boolean;
    }) => {
      try {
        const { runProjectCommand } = await import('./convenience.js');
        await runProjectCommand(opts);
      } catch (err) {
        process.stderr.write(`project failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    },
  );

program
  .command('project-mcp', { hidden: true })
  .description('Internal stdio MCP launcher for `clausroom project`.')
  .requiredOption('-c, --config <path>', 'generated project bridge config')
  .action(async (opts: { config: string }) => {
    try {
      const { runProjectMcp } = await import('./convenience.js');
      await runProjectMcp(opts.config);
    } catch (err) {
      process.stderr.write(
        `project bridge startup failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

program
  .command('project-auto', { hidden: true })
  .description('Internal auto-responder launcher for `clausroom host/connect --auto`.')
  .requiredOption('-c, --config <path>', 'generated project bridge config')
  .action(async (opts: { config: string }) => {
    try {
      const { runProjectAuto } = await import('./convenience.js');
      await runProjectAuto(opts.config);
    } catch (err) {
      process.stderr.write(
        `project auto-response startup failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

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

const peer = program
  .command('peer')
  .description(
    'Direct-only WebRTC transport for Clausroom. Both sides make outbound ICE/STUN ' +
      'connections and manually exchange an offer/answer; TURN relays are disabled.',
  );

peer
  .command('host')
  .description(
    'Create an offer, accept an answer, and forward peer traffic only to a fixed loopback Clausroom server.',
  )
  .option(
    '--target <url>',
    'fixed loopback Clausroom target (127.0.0.1, localhost, or ::1 only)',
    'http://127.0.0.1:3000',
  )
  .option('--stun <url>', 'STUN discovery URL (repeatable)', (value, previous?: string[]) => [
    ...(previous ?? []),
    value,
  ])
  .option('--no-stun', 'disable STUN and try host candidates only')
  .option('--answer-file <path>', 'read the manually exchanged answer code from a file')
  .action(
    async (opts: {
      target?: string;
      stun?: string[] | boolean;
      answerFile?: string;
    }) => {
      try {
        const { decodePeerRoomInvite, runPeerHost } = await import('./peer.js');
        const encodedRoomInvite = process.env.CLAUSROOM_PEER_ROOM_INVITE;
        await runPeerHost({
          target: opts.target,
          stunUrls: opts.stun === false ? [] : Array.isArray(opts.stun) ? opts.stun : undefined,
          answerFile: opts.answerFile,
          roomInvite: encodedRoomInvite ? decodePeerRoomInvite(encodedRoomInvite) : undefined,
        });
      } catch (err) {
        process.stderr.write(
          `peer host failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    },
  );

peer
  .command('join')
  .description(
    'Accept an offer, print an answer, and expose the connected room on a local-only HTTP URL.',
  )
  .option('--offer-file <path>', 'read the manually exchanged offer code from a file')
  .option('--listen-port <port>', 'local-only TCP proxy port; 0 chooses a free port', (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) throw new Error(`invalid port: ${value}`);
    return parsed;
  }, 0)
  .option('--stun <url>', 'STUN discovery URL (repeatable)', (value, previous?: string[]) => [
    ...(previous ?? []),
    value,
  ])
  .option('--no-stun', 'disable STUN and try host candidates only')
  .action(
    async (opts: {
      offerFile?: string;
      listenPort?: number;
      stun?: string[] | boolean;
    }) => {
      try {
        const { runPeerJoin } = await import('./peer.js');
        await runPeerJoin({
          offerFile: opts.offerFile,
          listenPort: opts.listenPort,
          stunUrls: opts.stun === false ? [] : Array.isArray(opts.stun) ? opts.stun : undefined,
        });
      } catch (err) {
        process.stderr.write(
          `peer join failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    },
  );

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
