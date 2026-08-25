/**
 * clausroom.toml — the whole configuration, in one file.
 *
 * This is the durable configuration. The explicit --agent and --auto launch
 * flags may override those two choices for one run. Facts discovered when a
 * room starts (its id, its URL, the agent's token) live in the session file
 * instead, so you never have to paste a credential into your config.
 *
 * Looked for at --config, otherwise ./clausroom.toml. If there is none, one is
 * written in the project directory and used immediately.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { expandHome, log } from './util.js';

const CONFIG_NAME = 'clausroom.toml';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const Schema = z.object({
  me: z.object({
    name: z.string().min(1).max(100),
    agent: z.enum(['claude', 'codex', 'none']),
  }),
  partner: z.object({
    name: z.string().min(1).max(100),
  }),
  room: z.object({
    name: z.string().min(1).max(200),
  }),
  project: z.object({
    dir: z.string().min(1),
  }),
  agent: z.object({
    send_messages: z.boolean(),
    upload_files: z.boolean(),
    max_upload_mb: z.number().positive().max(100),
    auto_reply: z.boolean(),
    tools: z.array(z.string().min(1)),
    model: z.string(),
    timeout_seconds: z.number().int().positive(),
    context_messages: z.number().int().positive(),
    command: z.array(z.string().min(1)),
  }),
  server: z.object({
    port: z.number().int().min(1).max(65535),
    data: z.string().min(1),
  }),
  peer: z.object({
    stun: z.array(z.string().min(1)).max(8),
    port: z.number().int().min(1).max(65535),
  }),
});

export type Config = z.infer<typeof Schema> & {
  /** Absolute path of the file this came from. */
  file: string;
};

export interface ConfigOverrides {
  agent?: Config['me']['agent'];
  auto?: boolean;
}

/**
 * The file written when there is none, and the reference for every key. The
 * project directory defaults to wherever the command was run, which is almost
 * always the project you meant.
 */
function template(): string {
  return `# clausroom — durable defaults; --agent and --auto may override one run.
# Room ids, URLs, and tokens are never stored here; they belong to a session.

[me]
name  = ${quote(os.userInfo().username || 'Me')}
agent = "claude"          # claude | codex | none

[partner]
name = "Guest"            # how the other person appears in the room

[room]
name = "clausroom"

[project]
# Clausroom resolves this against the config file, uses it as the agent's working
# directory, and refuses file transfers from outside it. The selected agent's own
# filesystem sandbox remains its responsibility.
dir = ${quote(process.cwd())}

[agent]
send_messages   = true    # may post text into the room
upload_files    = false   # may offer a file; you approve every one either way
max_upload_mb   = 25
auto_reply      = false   # answers messages addressed to it with no human turn

# Read only when auto_reply = true.
tools            = ["Read", "Grep", "Glob"]   # read-only on purpose
model            = ""     # "" = whatever the agent defaults to
timeout_seconds  = 300    # a run over this is killed and nothing is posted
context_messages = 30     # recent room messages included in the prompt
command          = []     # non-empty = run this argv instead of the agent CLI

[server]
# Only the host runs a server; it binds 127.0.0.1 and nothing else.
port = 3000
data = "~/.clausroom/data"

[peer]
# STUN only discovers a direct path. TURN relays are refused, so if the two
# networks cannot reach each other the connection fails instead of relaying.
stun = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]
port = 43001              # fixed so one SSH LocalForward keeps working
`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** --config, otherwise one project-local file in the command's directory. */
function locate(explicit: string | undefined): string {
  if (explicit) return path.resolve(expandHome(explicit));
  return path.resolve(CONFIG_NAME);
}

/**
 * Load the config, writing the template first if the file does not exist. The
 * returned paths are absolute: `project.dir` resolves against the config file's
 * own directory, so moving the file moves the project with it.
 */
export function loadConfig(explicit?: string, overrides: ConfigOverrides = {}): Config {
  const file = locate(explicit);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, template(), { mode: 0o600 });
    log(`[clausroom] wrote ${file} — edit it any time; using its defaults now.`);
  }

  let data: unknown;
  try {
    data = parseToml(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `${file} is not valid TOML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = Schema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(
      `${file} is missing or has invalid settings:\n${parsed.error.issues
        .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}\nDelete the file to have a fresh one written with every key.`,
    );
  }

  const config: Config = { ...parsed.data, file };
  const base = path.dirname(file);
  config.project.dir = path.resolve(base, expandHome(config.project.dir));
  config.server.data = path.resolve(base, expandHome(config.server.data));
  if (overrides.agent) config.me.agent = overrides.agent;
  if (overrides.auto) config.agent.auto_reply = true;

  if (config.agent.auto_reply && config.me.agent === 'none' && config.agent.command.length === 0) {
    throw new ConfigError(
      `${file}: agent.auto_reply is true but me.agent is "none" and agent.command is empty, ` +
        'so there is nothing to answer with. Set me.agent to claude or codex.',
    );
  }
  if (config.agent.auto_reply && !config.agent.send_messages) {
    throw new ConfigError(
      `${file}: agent.auto_reply is true but agent.send_messages is false, so every ` +
        'answer would be refused before it was sent. Set send_messages = true.',
    );
  }
  for (const url of config.peer.stun) {
    if (!url.startsWith('stun:') && !url.startsWith('stuns:')) {
      throw new ConfigError(
        `${file}: peer.stun accepts only stun:/stuns: URLs (got "${url}"). ` +
          'TURN relays are refused because peer mode is direct-only.',
      );
    }
  }
  if (config.project.dir === path.parse(config.project.dir).root) {
    throw new ConfigError(`${file}: project.dir cannot be the filesystem root.`);
  }
  if (config.project.dir === path.resolve(os.homedir())) {
    throw new ConfigError(
      `${file}: project.dir cannot be your home directory. Point it at one project.`,
    );
  }
  return config;
}

/** One line describing what the agent may do, for logs and room_get_status. */
export function summary(config: Config): string {
  const { agent } = config;
  return [
    `project ${config.project.dir}`,
    `send text ${agent.send_messages ? 'allowed' : 'DENIED'}`,
    `uploads ${agent.upload_files ? 'allowed, each one approved by you' : 'DENIED'}`,
    `max upload ${agent.max_upload_mb} MB`,
    `auto reply ${agent.auto_reply ? `on (${config.me.agent}, tools ${agent.tools.join(', ')})` : 'off'}`,
  ].join('; ');
}
