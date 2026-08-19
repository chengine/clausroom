/**
 * What this machine refuses to send, checked before any network call.
 *
 * A file must resolve — symlinks included — inside the one configured project
 * directory, must not look like key material, and must be under the size limit.
 * Secret-looking *content* is a hard refusal: if a human really means to share
 * it, they can upload it themselves through the browser.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import { DENY_GLOBS, SECRET_PATTERNS } from '@clausroom/protocol';
import type { Config } from './config.js';
import { expandHome } from './util.js';

/** Bytes read from the head of a file when scanning for secrets. */
const SCAN_BYTES = 5 * 1024 * 1024;

const SECRETS = SECRET_PATTERNS.map((src) => new RegExp(src));

/** A refusal by local policy. The message is written to be shown to the agent. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refused';
  }
}

export interface UploadTarget {
  absPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

const MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-patch',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

export function guessMime(filename: string): string {
  return MIME[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

/** Check one file against every local rule, or throw Refused. */
export async function checkUpload(config: Config, inputPath: string): Promise<UploadTarget> {
  if (!config.agent.upload_files) {
    throw new Refused(
      `agent.upload_files is false in ${config.file}, so no file may leave this machine. ` +
        'Share a path, a line range, or a commit id instead.',
    );
  }

  const requested = path.resolve(config.project.dir, expandHome(inputPath));
  let absPath: string;
  let root: string;
  try {
    // Resolve symlinks on both sides before comparing, so a link inside the
    // project cannot point out of it.
    absPath = await fsp.realpath(requested);
    root = await fsp.realpath(config.project.dir);
  } catch {
    throw new Refused(`No such readable file: ${requested}`);
  }

  const relPath = path.relative(root, absPath);
  if (relPath === '' || relPath.startsWith('..') || path.isAbsolute(relPath)) {
    throw new Refused(
      `${absPath} is outside the project directory (${root}). Only files inside it can be shared.`,
    );
  }
  for (const glob of DENY_GLOBS) {
    if (minimatch(absPath, glob, { dot: true }) || minimatch(relPath, glob, { dot: true })) {
      throw new Refused(`${relPath} matches the always-on deny rule "${glob}".`);
    }
  }

  const stat = await fsp.stat(absPath);
  if (!stat.isFile()) throw new Refused(`${absPath} is not a regular file.`);
  const limit = config.agent.max_upload_mb * 1024 * 1024;
  if (stat.size > limit) {
    throw new Refused(
      `${relPath} is ${stat.size} bytes, over the ${config.agent.max_upload_mb} MB limit. ` +
        'Share a reference to it instead.',
    );
  }

  const secret = await secretIn(absPath);
  if (secret) {
    throw new Refused(
      `${relPath} looks like it contains credentials (matched /${secret}/) and will not be sent. ` +
        'A human can upload it through the browser if they really mean to.',
    );
  }

  const filename = path.basename(absPath);
  return { absPath, filename, mimeType: guessMime(filename), sizeBytes: stat.size };
}

/** The first secret pattern found in the head of a text file, or null. */
async function secretIn(absPath: string): Promise<string | null> {
  const handle = await fsp.open(absPath, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(Math.min(size, SCAN_BYTES));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    // A NUL byte means binary; scanning it for text patterns is meaningless.
    if (head.includes(0)) return null;
    const text = head.toString('utf8');
    return SECRETS.find((re) => re.test(text))?.source ?? null;
  } finally {
    await handle.close();
  }
}

/** Why this text may not be sent, or null when it is fine. */
export function checkText(body: string): string | null {
  if (body.trim().length === 0) return 'The message body is empty.';
  if (/[A-Za-z0-9+/=]{2000,}/.test(body)) {
    return 'Blocked: this contains a long base64 run. Upload an artifact instead of pasting file content.';
  }
  const secret = SECRETS.find((re) => re.test(body));
  return secret
    ? `Blocked: this matches the secret pattern /${secret.source}/. Never send credentials into the room.`
    : null;
}
