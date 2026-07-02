/**
 * Environment parsing for the clausroom server (see docs/API-CONTRACT.md §10).
 * Every value comes from AGENT_ROOM_* variables and is validated with zod.
 */
import { z } from 'zod';
import { DEFAULTS } from '@clausroom/protocol';

const EnvSchema = z.object({
  AGENT_ROOM_HOST: z.string().min(1).default(DEFAULTS.HOST),
  AGENT_ROOM_PORT: z.coerce.number().int().min(0).max(65535).default(DEFAULTS.PORT),
  AGENT_ROOM_DB: z.string().min(1).default('./data/clausroom.sqlite'),
  AGENT_ROOM_ARTIFACT_DIR: z.string().min(1).default('./data/artifacts'),
  AGENT_ROOM_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULTS.MAX_UPLOAD_BYTES),
  AGENT_ROOM_REQUIRE_APPROVAL_BYTES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(DEFAULTS.REQUIRE_APPROVAL_BYTES),
  AGENT_ROOM_MAX_AUTO_TURNS: z.coerce.number().int().positive().default(DEFAULTS.MAX_AUTO_TURNS),
  AGENT_ROOM_WEB_DIST: z.string().min(1).optional(),
  AGENT_ROOM_PUBLIC_BASE_URL: z.string().min(1).optional(),
});

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  artifactDir: string;
  maxUploadBytes: number;
  requireApprovalBytes: number;
  maxAutoTurns: number;
  webDist: string | undefined;
  publicBaseUrl: string | undefined;
}

/** Parse process.env (empty strings are treated as unset). */
export function loadConfig(env: NodeJS.ProcessEnv): ServerConfig {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.trim() !== '') cleaned[key] = value;
  }
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid AGENT_ROOM_* environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    host: e.AGENT_ROOM_HOST,
    port: e.AGENT_ROOM_PORT,
    dbPath: e.AGENT_ROOM_DB,
    artifactDir: e.AGENT_ROOM_ARTIFACT_DIR,
    maxUploadBytes: e.AGENT_ROOM_MAX_UPLOAD_BYTES,
    requireApprovalBytes: e.AGENT_ROOM_REQUIRE_APPROVAL_BYTES,
    maxAutoTurns: e.AGENT_ROOM_MAX_AUTO_TURNS,
    webDist: e.AGENT_ROOM_WEB_DIST,
    publicBaseUrl: e.AGENT_ROOM_PUBLIC_BASE_URL,
  };
}
