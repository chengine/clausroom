/**
 * Server-side policy helpers: agent turn limit, per-user sliding-window rate
 * limit, inline-base64-blob detector, filename sanitizer, secret-name glob
 * matcher, and archive detection. Constants come from @clausroom/protocol.
 */
import path from 'node:path';
import { minimatch } from 'minimatch';
import { DEFAULTS, SECRET_NAME_GLOBS } from '@clausroom/protocol';
import type { Store } from './db.js';

/** Any run of 2000+ base64-alphabet chars — reject with 422 inline_blob. */
const INLINE_BLOB_RE = /[A-Za-z0-9+/=]{2000,}/;

export function hasInlineBlob(body: string): boolean {
  return INLINE_BLOB_RE.test(body);
}

/**
 * Sanitize an upload filename: basename only, keep [A-Za-z0-9._\- ()] (every
 * other char becomes '_'), truncate to 128 chars, fall back to "file".
 */
export function sanitizeFilename(original: string): string {
  const base = path.basename(original ?? '');
  const cleaned = base.replace(/[^A-Za-z0-9._\- ()]/g, '_').slice(0, 128);
  return cleaned.length > 0 ? cleaned : 'file';
}

/**
 * True if the filename looks secret-like per SECRET_NAME_GLOBS.
 * Globs are matched against the sanitized basename with
 * { dot: true, nocase: true }; entries containing '/' are also matched
 * against the client-supplied original name.
 */
export function matchesSecretNameGlob(sanitizedBasename: string, originalName: string): boolean {
  const opts = { dot: true, nocase: true } as const;
  for (const glob of SECRET_NAME_GLOBS) {
    if (minimatch(sanitizedBasename, glob, opts)) return true;
    if (glob.includes('/') && minimatch(originalName, glob, opts)) return true;
  }
  return false;
}

const ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz'];
const ARCHIVE_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
  'application/x-bzip2',
  'application/x-xz',
]);

/** True if the upload is an archive by extension or declared mime type. */
export function isArchive(filename: string, mimeType: string): boolean {
  const lower = filename.toLowerCase();
  if (ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return ARCHIVE_MIME_TYPES.has(mimeType.toLowerCase());
}

/**
 * Length of the trailing run of consecutive agent-sent messages in a room.
 * Walks newest -> oldest; system_event messages neither extend nor break the
 * run; any other non-agent message breaks it.
 */
export function countTrailingAgentRun(store: Store, roomId: string): number {
  let run = 0;
  for (const row of store.iterateMessagesDesc(roomId)) {
    if (row.message_type === 'system_event') continue;
    if (row.sender_kind === 'agent') {
      run += 1;
      continue;
    }
    break;
  }
  return run;
}

/**
 * Per-user sliding-window rate limiter for accepted messages
 * (DEFAULTS.MESSAGE_RATE_PER_MIN per trailing 60 s).
 */
export class MessageRateLimiter {
  private readonly windowMs: number;
  private readonly max: number;
  private readonly accepted = new Map<string, number[]>();

  constructor(max: number = DEFAULTS.MESSAGE_RATE_PER_MIN, windowMs = 60_000) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** True if the user may send another message right now (does not record). */
  allows(userId: string, now = Date.now()): boolean {
    return this.pruned(userId, now).length < this.max;
  }

  /** Record an accepted message for the user. */
  record(userId: string, now = Date.now()): void {
    const stamps = this.pruned(userId, now);
    stamps.push(now);
    this.accepted.set(userId, stamps);
  }

  private pruned(userId: string, now: number): number[] {
    const cutoff = now - this.windowMs;
    const stamps = (this.accepted.get(userId) ?? []).filter((t) => t > cutoff);
    this.accepted.set(userId, stamps);
    return stamps;
  }
}
