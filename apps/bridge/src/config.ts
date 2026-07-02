/**
 * Bridge configuration: parse ~/.clausroom/bridge.toml (or --config path) with
 * smol-toml, validate with zod, and resolve the bridge token from the env var
 * named by [room].token_env. Shape is BINDING per docs/API-CONTRACT.md §13.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import { DEFAULTS, TOKEN_PREFIXES } from '@clausroom/protocol';

/** Default config file location. */
export const DEFAULT_CONFIG_PATH = '~/.clausroom/bridge.toml';

/** Thrown for any configuration problem; the message is meant for humans. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Expand a leading `~` or `~/` to the current user's home directory. */
export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

const IdentitySchema = z.object({
  human_name: z.string().min(1, 'identity.human_name is required'),
  agent_name: z.string().min(1, 'identity.agent_name is required'),
  bridge_name: z.string().min(1, 'identity.bridge_name is required'),
});

const RoomSectionSchema = z.object({
  server_url: z
    .string()
    .min(1, 'room.server_url is required')
    .transform((s) => s.replace(/\/+$/, ''))
    .refine(
      (s) => {
        try {
          const u = new URL(s);
          return u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'room.server_url must be an http(s) URL' },
    ),
  room_id: z.string().min(1, 'room.room_id is required'),
  token_env: z.string().min(1).default('AGENT_ROOM_BRIDGE_TOKEN'),
});

const PolicySectionSchema = z.object({
  read_only_default: z.boolean().default(true),
  allow_agent_to_send_text: z.boolean().default(true),
  allow_agent_to_upload_files: z.boolean().default(false),
  require_human_approval_for_uploads: z.boolean().default(true),
  max_upload_bytes_without_approval: z
    .number()
    .int()
    .positive()
    .default(DEFAULTS.REQUIRE_APPROVAL_BYTES),
  max_upload_bytes_absolute: z.number().int().positive().default(DEFAULTS.MAX_UPLOAD_BYTES),
});

const FilesystemSectionSchema = z.object({
  /** Uploads must resolve (after symlinks) inside one of these directories. */
  roots: z.array(z.string().min(1)).default([]),
  /** ADDED to DEFAULT_DENY_GLOBS from @clausroom/protocol, never replacing them. */
  deny_globs: z.array(z.string().min(1)).default([]),
  /** Optional; default is ~/.clausroom/downloads/<room_id>. */
  downloads_dir: z.string().min(1).optional(),
});

export const BridgeConfigSchema = z.object({
  identity: IdentitySchema,
  room: RoomSectionSchema,
  policy: PolicySectionSchema.default({}),
  filesystem: FilesystemSectionSchema.default({}),
});

export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

/**
 * Load, parse, and validate the bridge config file.
 * Home-relative paths in [filesystem] are expanded; roots are made absolute.
 */
export function loadConfig(configPath?: string): BridgeConfig {
  const rawPath = configPath && configPath.length > 0 ? configPath : DEFAULT_CONFIG_PATH;
  const resolved = path.resolve(expandHome(rawPath));

  let text: string;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new ConfigError(
      `Cannot read bridge config at ${resolved}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Create it (default location ${DEFAULT_CONFIG_PATH}) or pass --config <path>. See docs/API-CONTRACT.md §13 for the shape.`,
    );
  }

  let data: unknown;
  try {
    data = parseToml(text);
  } catch (err) {
    throw new ConfigError(
      `Invalid TOML in ${resolved}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const parsed = BridgeConfigSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigError(`Invalid bridge config ${resolved}:\n${issues}`);
  }

  const cfg = parsed.data;

  // Contract §13: read_only_default = true means "only read/status tools work
  // unless overridden below". Write-permission flags NOT explicitly set in the
  // TOML therefore default to false (not to their permissive zod defaults).
  if (cfg.policy.read_only_default) {
    const rawPolicy =
      typeof data === 'object' && data !== null && 'policy' in data
        ? (data as Record<string, unknown>).policy
        : undefined;
    const explicitlySet = (key: string): boolean =>
      typeof rawPolicy === 'object' && rawPolicy !== null && key in rawPolicy;
    if (!explicitlySet('allow_agent_to_send_text')) {
      cfg.policy.allow_agent_to_send_text = false;
    }
    if (!explicitlySet('allow_agent_to_upload_files')) {
      cfg.policy.allow_agent_to_upload_files = false;
    }
  }

  cfg.filesystem.roots = cfg.filesystem.roots.map((r) => path.resolve(expandHome(r)));
  if (cfg.filesystem.downloads_dir) {
    cfg.filesystem.downloads_dir = path.resolve(expandHome(cfg.filesystem.downloads_dir));
  }
  return cfg;
}

/**
 * Resolve the bridge token from the environment variable named by
 * [room].token_env. Errors clearly if the variable is unset or empty.
 * Warns (to stderr, via the returned warning) if the value does not look like
 * a bridge token.
 */
export function resolveToken(cfg: BridgeConfig): { token: string; warning: string | null } {
  const envName = cfg.room.token_env;
  const token = process.env[envName];
  if (token === undefined || token.trim() === '') {
    throw new ConfigError(
      `Bridge token env var ${envName} is not set (named by [room].token_env in the config).\n` +
        `Export the arbt_ bridge token given by the room owner, e.g.:\n` +
        `  export ${envName}="arbt_..."`,
    );
  }
  const trimmed = token.trim();
  let warning: string | null = null;
  if (!trimmed.startsWith(TOKEN_PREFIXES.bridge)) {
    warning = `warning: ${envName} does not start with "${TOKEN_PREFIXES.bridge}" — it may not be a bridge token.`;
  }
  return { token: trimmed, warning };
}
