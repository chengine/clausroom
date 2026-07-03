/**
 * Shared constants for clausroom. These values are BINDING for server, web, and
 * bridge implementations — see docs/API-CONTRACT.md.
 */

/** Bearer-token prefixes, keyed by token kind (matches tokens.kind in the DB). */
export const TOKEN_PREFIXES = {
  /** Single-use invite token, exchanged at POST /api/auth/login. */
  invite: 'arit_',
  /** Human session token. */
  session: 'arst_',
  /** Agent bridge token (room-scoped). */
  bridge: 'arbt_',
} as const;
export type TokenKind = keyof typeof TOKEN_PREFIXES;

/** Allowed values for Message.message_type. */
export const MESSAGE_TYPES = [
  'human_message',
  'agent_question',
  'agent_answer',
  'evidence',
  'artifact_uploaded',
  'approval_request',
  'approval_response',
  'system_event',
  'resolution_summary',
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** Allowed values for Message.confidence. */
export const CONFIDENCE = ['low', 'medium', 'high'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

/** Allowed values for Approval.approval_type. */
export const APPROVAL_TYPES = ['artifact_upload', 'shell_command', 'code_edit', 'other'] as const;
export type ApprovalType = (typeof APPROVAL_TYPES)[number];

/** Machine-readable error codes used in every non-2xx response body. */
export const ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation',
  'turn_limit',
  'agents_paused',
  'participant_paused',
  'approval_required',
  'inline_blob',
  'rate_limited',
  'too_large',
  'quota_exceeded',
  'conflict',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Server defaults (overridable via AGENT_ROOM_* env vars — see docs/API-CONTRACT.md). */
export const DEFAULTS = {
  /** AGENT_ROOM_HOST */
  HOST: '127.0.0.1',
  /** AGENT_ROOM_PORT (0 = ephemeral) */
  PORT: 3000,
  /** AGENT_ROOM_MAX_UPLOAD_BYTES — absolute single-upload cap (100 MiB). */
  MAX_UPLOAD_BYTES: 104857600,
  /** AGENT_ROOM_REQUIRE_APPROVAL_BYTES — agent uploads above this need approval (1 MiB). */
  REQUIRE_APPROVAL_BYTES: 1048576,
  /** AGENT_ROOM_MAX_AUTO_TURNS — max consecutive agent messages before a human must speak. */
  MAX_AUTO_TURNS: 3,
  /** Per-user sliding-window message rate limit (messages per minute). */
  MESSAGE_RATE_PER_MIN: 30,
  /** Max characters in Message.body_markdown. */
  MAX_BODY_CHARS: 32000,
  /** Pending approvals older than this are treated as expired (1 hour). */
  APPROVAL_TTL_MS: 3600000,
  /**
   * AGENT_ROOM_ARTIFACT_RETENTION_DAYS — artifact retention in days (float).
   * 0 = immediate expiry; negative or the string 'off' disables retention
   * (artifacts never expire; expires_at is null).
   */
  ARTIFACT_RETENTION_DAYS: 30,
  /** AGENT_ROOM_ROOM_STORAGE_BYTES — per-room artifact storage quota (1 GiB). */
  ROOM_STORAGE_BYTES: 1073741824,
  /** AGENT_ROOM_SESSION_TTL_DAYS — session-token sliding expiry in days (float). */
  SESSION_TTL_DAYS: 30,
  /** Max characters in Room.summary_markdown. */
  SUMMARY_MAX_CHARS: 4000,
  /** Max entries in Message.choices. */
  CHOICES_MAX: 6,
  /** Max characters per Message.choices entry. */
  CHOICE_MAX_CHARS: 120,
  /**
   * Agent activity ('working' pill) auto-reverts to idle after this many ms
   * without a refreshing {type:'status'} WS frame.
   */
  ACTIVITY_IDLE_TIMEOUT_MS: 60000,
} as const;

/**
 * Secret-content regex SOURCES (compile with `new RegExp(src)`; no flags needed,
 * add 'i' only where noted by implementers — match is case-sensitive by contract).
 * Any match in text content blocks an agent-initiated upload/message.
 * From spec section 12.3.
 */
export const SECRET_CONTENT_PATTERNS: readonly string[] = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'BEGIN RSA PRIVATE KEY',
  'BEGIN OPENSSH PRIVATE KEY',
  'xoxb-',
  'ghp_',
  'github_pat_',
  'sk-[^\\s]{8,}',
];

/**
 * Regex SOURCE matching any raw clausroom bearer token (invite/session/bridge):
 * `ar(it|st|bt)_` + 32 lowercase hex chars. Compile with `new RegExp(src, 'g')`.
 */
export const CLAUSROOM_TOKEN_PATTERN = 'ar(?:it|st|bt)_[0-9a-f]{32}';

/**
 * Redaction regex SOURCES applied by the server to `body_markdown` of every
 * posted message (all sender kinds) BEFORE storage and broadcast: each match is
 * replaced with the literal string `[redacted-secret]`. Best-effort — this is a
 * seatbelt, not a guarantee. Compile each with `new RegExp(src, 'g')`.
 */
export const REDACTION_PATTERNS: readonly string[] = [
  ...SECRET_CONTENT_PATTERNS,
  CLAUSROOM_TOKEN_PATTERN,
];

/**
 * Secret-like FILENAME globs (minimatch, matched against the sanitized basename
 * and — where the glob contains '/' — against the original relative path).
 * A match forces the approval gate for agent uploads. From spec section 5.5.
 */
export const SECRET_NAME_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_ed25519',
  '.ssh/**',
  '.aws/**',
  '.gcp/**',
  '.azure/**',
  '**/secrets/**',
  '**/*token*',
  '**/*credential*',
];

/**
 * Default bridge filesystem deny globs (minimatch, matched against absolute and
 * root-relative paths, dot:true). The bridge refuses to read/upload matches.
 * From spec section 6.2.
 */
export const DEFAULT_DENY_GLOBS: readonly string[] = [
  '**/.env',
  '**/.env.*',
  '**/.ssh/**',
  '**/*.pem',
  '**/*.key',
  '**/*token*',
  '**/*credential*',
  '**/secrets/**',
  '**/node_modules/**',
  '**/.git/**',
];
