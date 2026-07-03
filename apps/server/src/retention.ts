/**
 * Artifact retention sweep (docs/API-CONTRACT.md §5): on boot and every
 * 10 minutes, find artifacts with `deleted_at IS NULL AND expires_at IS NOT
 * NULL AND expires_at <= now`, unlink each stored file (missing files are
 * ignored), and set `deleted_at`. Rows are never deleted — metadata routes
 * keep returning them — and the sweep emits no message or WS frame. Freed
 * bytes stop counting toward the room storage quota once `deleted_at` is set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { nowIso, type Store } from './db.js';

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Run one sweep pass; returns the number of artifacts swept. */
export function sweepExpiredArtifacts(store: Store): number {
  const now = nowIso();
  const rows = store.listExpiredArtifacts(now);
  for (const row of rows) {
    try {
      fs.unlinkSync(row.storage_path);
    } catch {
      // Missing files are ignored; any other unlink failure is best-effort —
      // the row is still marked deleted so it stops counting toward the quota.
    }
    try {
      // The per-artifact directory holds only this file; tidy it up (rmdirSync
      // refuses non-empty dirs, so this can never remove anything else).
      fs.rmdirSync(path.dirname(row.storage_path));
    } catch {
      // best-effort only
    }
    store.markArtifactDeleted(row.id, now);
  }
  return rows.length;
}

/**
 * Sweep once now (boot) and then every SWEEP_INTERVAL_MS on an unref()'d
 * interval. Returns a stop function for graceful shutdown.
 */
export function startRetentionSweep(store: Store): () => void {
  sweepExpiredArtifacts(store);
  const timer = setInterval(() => {
    try {
      sweepExpiredArtifacts(store);
    } catch (err) {
      console.error('[clausroom] retention sweep failed:', err);
    }
  }, SWEEP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
