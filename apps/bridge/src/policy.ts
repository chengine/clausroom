/**
 * Local upload policy enforcement (spec §6.5 / contract §13). Runs BEFORE any
 * network call:
 *
 *   resolve path (symlinks included) → must be under a configured root →
 *   must not match deny globs (defaults + config) → size ≤ absolute cap →
 *   secret filename/content scan → decide whether human approval is required.
 *
 * Hard failures throw PolicyError; the caller turns them into readable tool
 * results. Secret-like *content* is always a hard block. Secret-like *names*,
 * sizes over the approval threshold, and restrictive policy flags route the
 * upload through the human-approval gate instead.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { minimatch } from 'minimatch';
import {
  DEFAULT_DENY_GLOBS,
  SECRET_CONTENT_PATTERNS,
  SECRET_NAME_GLOBS,
} from '@clausroom/protocol';
import { expandHome, type BridgeConfig } from './config.js';

/** Bytes of file content scanned for secret patterns (text-like files only). */
export const SECRET_SCAN_BYTES = 5 * 1024 * 1024; // first 5 MB

/** A local-policy refusal. `message` is safe to show to the agent. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface UploadCheckResult {
  /** Fully resolved absolute path (symlinks resolved). */
  absPath: string;
  /** The configured root that contains the file (resolved). */
  root: string;
  /** Path relative to that root. */
  relPath: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  /** True when the upload must go through the human-approval gate. */
  requiresApproval: boolean;
  /** Human-readable reasons approval is required (empty when it is not). */
  approvalReasons: string[];
}

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-patch',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
};

export function guessMimeType(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

// Mirrors the server's archive detection (apps/server/src/policy.ts, contract
// §5): the server ALWAYS requires an approved approval for agent archive
// uploads, so the local policy must route archives through the approval gate
// too — otherwise permissive configs get a raw 403 instead of the documented
// auto-created approval request.
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

function isArchive(filename: string, mimeType: string): boolean {
  const lower = filename.toLowerCase();
  if (ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return true;
  return ARCHIVE_MIME_TYPES.has(mimeType.toLowerCase());
}

/** SHA-256 (lowercase hex) of a file, streamed. */
async function sha256File(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(absPath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Read at most `limit` bytes from the start of the file. */
async function readHead(absPath: string, limit: number): Promise<Buffer> {
  const handle = await fsp.open(absPath, 'r');
  try {
    const stat = await handle.stat();
    const len = Math.min(stat.size, limit);
    const buf = Buffer.alloc(len);
    if (len > 0) await handle.read(buf, 0, len, 0);
    return buf;
  } finally {
    await handle.close();
  }
}

/** Heuristic: a NUL byte in the head means binary; skip content scanning. */
function looksBinary(head: Buffer): boolean {
  return head.includes(0);
}

let compiledSecretPatterns: RegExp[] | null = null;
function secretPatterns(): RegExp[] {
  if (!compiledSecretPatterns) {
    compiledSecretPatterns = SECRET_CONTENT_PATTERNS.map((src) => new RegExp(src));
  }
  return compiledSecretPatterns;
}

/**
 * Match `absPath`/`relPath` against a deny glob with minimatch { dot: true }.
 * A glob matches if it matches either the absolute path or the root-relative path.
 */
function deniedBy(absPath: string, relPath: string, glob: string): boolean {
  const opts = { dot: true } as const;
  return minimatch(absPath, glob, opts) || minimatch(relPath, glob, opts);
}

/** True when any deny glob matches the absolute or root-relative path. */
export function pathIsDenied(absPath: string, relPath: string, denyGlobs: readonly string[]): boolean {
  return denyGlobs.some((glob) => deniedBy(absPath, relPath, glob));
}

/**
 * Secret-like filename check (SECRET_NAME_GLOBS): matched against the basename
 * with { dot: true, nocase: true }; globs containing '/' are also matched
 * against the root-relative path.
 */
function matchSecretName(basename: string, relPath: string): string | null {
  const opts = { dot: true, nocase: true } as const;
  for (const glob of SECRET_NAME_GLOBS) {
    if (minimatch(basename, glob, opts)) return glob;
    if (glob.includes('/') && minimatch(relPath, glob, opts)) return glob;
  }
  return null;
}

/**
 * Run the full local upload-policy pipeline for `inputPath`.
 * Throws PolicyError on any hard refusal; otherwise returns the file metadata
 * plus whether the upload requires an approved human approval.
 */
export async function checkUploadPolicy(
  cfg: BridgeConfig,
  inputPath: string,
): Promise<UploadCheckResult> {
  // 1. Resolve to a real absolute path (symlinks resolved BEFORE containment).
  const candidate = path.resolve(expandHome(inputPath));
  let absPath: string;
  try {
    absPath = await fsp.realpath(candidate);
  } catch {
    throw new PolicyError(`File not found or unreadable: ${candidate}`);
  }

  const stat = await fsp.stat(absPath);
  if (!stat.isFile()) {
    throw new PolicyError(
      `Not a regular file: ${absPath}. Directories and special files cannot be uploaded; upload individual files.`,
    );
  }

  // 2. Containment: the resolved path must live under a configured root
  //    (roots are realpath'd too, so symlinked roots behave predictably).
  if (cfg.filesystem.roots.length === 0) {
    throw new PolicyError(
      'No [filesystem].roots are configured in bridge.toml, so no file may be uploaded. Ask your human to configure roots.',
    );
  }
  let containedRoot: string | null = null;
  let relPath = '';
  for (const rootRaw of cfg.filesystem.roots) {
    let root: string;
    try {
      root = await fsp.realpath(rootRaw);
    } catch {
      continue; // configured root does not exist; it cannot contain anything
    }
    const rel = path.relative(root, absPath);
    if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      containedRoot = root;
      relPath = rel;
      break;
    }
  }
  if (containedRoot === null) {
    throw new PolicyError(
      `Path ${absPath} resolves outside the configured filesystem roots (${cfg.filesystem.roots.join(', ')}). ` +
        'Uploads are only allowed from inside those roots.',
    );
  }

  // 3. Deny globs: defaults from @clausroom/protocol plus config additions.
  const denyGlobs = [...DEFAULT_DENY_GLOBS, ...cfg.filesystem.deny_globs];
  for (const glob of denyGlobs) {
    if (deniedBy(absPath, relPath, glob)) {
      throw new PolicyError(
        `Path ${absPath} matches deny glob "${glob}" and cannot be uploaded.`,
      );
    }
  }

  // 4. Size caps.
  const sizeBytes = stat.size;
  if (sizeBytes > cfg.policy.max_upload_bytes_absolute) {
    throw new PolicyError(
      `File is ${sizeBytes} bytes, over the absolute upload limit of ${cfg.policy.max_upload_bytes_absolute} bytes. ` +
        'Share a reference (path, commit, branch) instead of the file.',
    );
  }

  const filename = path.basename(absPath);

  // 5. Secret filename check → forces the approval gate.
  const secretNameGlob = matchSecretName(filename, relPath);

  // 6. Secret content scan (first SECRET_SCAN_BYTES of text-like files) → hard block.
  const head = await readHead(absPath, SECRET_SCAN_BYTES);
  if (!looksBinary(head)) {
    const text = head.toString('utf8');
    for (const re of secretPatterns()) {
      if (re.test(text)) {
        throw new PolicyError(
          `Blocked: secret-like content refused (matched pattern /${re.source}/). ` +
            'This file appears to contain credentials or key material and will not be uploaded by the bridge. ' +
            'If the human really wants to share it, they must upload it manually through the browser UI.',
        );
      }
    }
  }

  const sha256 = await sha256File(absPath);
  const mimeType = guessMimeType(filename);

  // 7. Approval decision.
  const approvalReasons: string[] = [];
  if (secretNameGlob !== null) {
    approvalReasons.push(`filename matches secret-like glob "${secretNameGlob}"`);
  }
  if (isArchive(filename, mimeType)) {
    approvalReasons.push(
      'the file is an archive — the server always requires human approval for agent archive uploads',
    );
  }
  if (sizeBytes > cfg.policy.max_upload_bytes_without_approval) {
    approvalReasons.push(
      `size ${sizeBytes} bytes exceeds max_upload_bytes_without_approval (${cfg.policy.max_upload_bytes_without_approval})`,
    );
  }
  if (cfg.policy.require_human_approval_for_uploads) {
    approvalReasons.push('policy.require_human_approval_for_uploads is enabled');
  }
  if (!cfg.policy.allow_agent_to_upload_files) {
    approvalReasons.push(
      'policy.allow_agent_to_upload_files is false — uploads only proceed with explicit human approval',
    );
  }

  return {
    absPath,
    root: containedRoot,
    relPath,
    filename,
    mimeType,
    sizeBytes,
    sha256,
    requiresApproval: approvalReasons.length > 0,
    approvalReasons,
  };
}

/**
 * Contract §13 [auto]: the engine workdir MUST realpath-resolve (symlinks and
 * `~` expanded) inside one of [filesystem].roots, else the bridge refuses to
 * start the auto responder. Same containment technique as checkUploadPolicy,
 * with two deliberate differences: the target must be a directory (not a
 * file), and the workdir may be exactly equal to a root (uploading the root
 * itself makes no sense; working *in* the root does).
 * Returns the fully resolved workdir path; throws PolicyError otherwise.
 */
export async function checkWorkdirPolicy(cfg: BridgeConfig, workdir: string): Promise<string> {
  const candidate = path.resolve(expandHome(workdir));
  let absPath: string;
  try {
    absPath = await fsp.realpath(candidate);
  } catch {
    throw new PolicyError(`auto.workdir does not exist or is unreadable: ${candidate}`);
  }
  const stat = await fsp.stat(absPath);
  if (!stat.isDirectory()) {
    throw new PolicyError(`auto.workdir is not a directory: ${absPath}`);
  }
  if (cfg.filesystem.roots.length === 0) {
    throw new PolicyError(
      'No [filesystem].roots are configured in bridge.toml. auto.workdir must resolve inside one of them; ' +
        'configure roots before running the auto responder.',
    );
  }
  for (const rootRaw of cfg.filesystem.roots) {
    let root: string;
    try {
      root = await fsp.realpath(rootRaw);
    } catch {
      continue; // configured root does not exist; it cannot contain anything
    }
    const rel = path.relative(root, absPath);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return absPath;
    }
  }
  throw new PolicyError(
    `auto.workdir ${absPath} resolves outside the configured filesystem roots (${cfg.filesystem.roots.join(', ')}). ` +
      'Refusing to start the auto responder.',
  );
}

/** Result of enumerating a bounded, deny-glob-filtered repo file tree. */
export interface FileTreeResult {
  /** Indented, root-relative listing (directories carry a trailing '/'). */
  tree: string;
  /** Number of entries listed. */
  count: number;
  /** True when the cap was hit and the listing is incomplete. */
  truncated: boolean;
}

/**
 * Enumerate a bounded file tree under `root` for injection into the engine
 * prompt (contract §13 confinement): the auto responder denies the engine's
 * Glob tool (it cannot be path-scoped and would leak file NAMES outside the
 * roots), so the bridge itself discovers the structure — staying inside `root`,
 * honoring `denyGlobs` (defaults + config: these already prune node_modules,
 * .git, .env, secrets, key material), never following symlinks (which could
 * escape the root or loop), and capping the listing at `maxEntries`.
 */
export async function buildFileTree(
  root: string,
  denyGlobs: readonly string[],
  maxEntries: number,
): Promise<FileTreeResult> {
  const lines: string[] = [];
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (EACCES etc.) — skip quietly
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      // Skip symlinks and special files: only real files/dirs are listed, so
      // the tree cannot escape `root` or loop through a symlink cycle.
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      const indent = '  '.repeat(depth);
      if (entry.isDirectory()) {
        // Prune the whole subtree when a deny glob covers its contents
        // (e.g. **/node_modules/**, **/.git/**, **/secrets/**). The sentinel
        // child makes "contents of X" globs match the directory itself.
        if (pathIsDenied(path.join(abs, '_'), path.join(rel, '_'), denyGlobs)) continue;
        lines.push(`${indent}${entry.name}/`);
        await walk(abs, depth + 1);
        if (truncated) return;
      } else if (entry.isFile()) {
        if (pathIsDenied(abs, rel, denyGlobs)) continue;
        lines.push(`${indent}${entry.name}`);
      }
    }
  };

  await walk(root, 0);
  return { tree: lines.join('\n'), count: lines.length, truncated };
}

/**
 * Local checks for outgoing message text (spec §6.4): reject huge inline
 * base64-ish blobs and obvious secret material before any network call.
 * Returns a human-readable refusal string, or null when the body is OK.
 */
export function checkOutgoingText(body: string): string | null {
  if (body.trim().length === 0) {
    return 'Message body is empty. Write the message content in body_markdown.';
  }
  if (/[A-Za-z0-9+/=]{2000,}/.test(body)) {
    return (
      'Message blocked by local policy: it contains a 2000+ character base64-like run. ' +
      'Do not inline file content in messages; upload an artifact instead (room_upload_artifact).'
    );
  }
  for (const re of secretPatterns()) {
    if (re.test(body)) {
      return (
        `Message blocked by local policy: it matches the secret pattern /${re.source}/. ` +
        'Never send credentials, API keys, or key material into the room.'
      );
    }
  }
  return null;
}

/** One-line policy summary for startup logs and room_get_status. */
export function policySummary(cfg: BridgeConfig): string {
  const p = cfg.policy;
  const parts = [
    p.read_only_default ? 'read-only default' : 'read-write default',
    `send text ${p.allow_agent_to_send_text ? 'allowed' : 'DENIED'}`,
    `agent uploads ${p.allow_agent_to_upload_files ? 'allowed' : 'approval-gated'}`,
    `uploads require approval above ${p.max_upload_bytes_without_approval} bytes` +
      (p.require_human_approval_for_uploads ? ' (and always, per config)' : ''),
    `absolute upload cap ${p.max_upload_bytes_absolute} bytes`,
    `roots: ${cfg.filesystem.roots.length > 0 ? cfg.filesystem.roots.join(', ') : '(none configured)'}`,
  ];
  return parts.join('; ');
}
