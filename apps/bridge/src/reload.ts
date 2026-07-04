/**
 * Tier-2 config HOT-RELOAD (LOCAL-only, never server-pushed — contract §3
 * Tier-1/Tier-2 split, §13). Watches the bridge.toml in use and, on change,
 * re-parses + zod-validates it and atomically swaps the in-memory config that
 * subsequent operations read. A failed reload KEEPS the previous config and
 * logs the error — it must NEVER crash the long-lived `mcp` / `auto` process.
 *
 * The connection identity (server_url, room_id, token) is bound once at startup
 * and is intentionally NOT hot-swapped — you cannot move a live socket/token to
 * a different room. Only the LOCAL security boundary and behavior read from the
 * store live: [policy] (roots via [filesystem], deny_globs, upload thresholds,
 * allow_* flags) and [auto] (allowed_tools, model, max_turns, timeout_seconds,
 * respond_to, max_context_messages, and — via [filesystem].roots — the engine's
 * scoped Read matchers and injected file tree).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG_PATH, expandHome, loadConfig, type BridgeConfig } from './config.js';

/** Coalesce the burst of fs events a single editor save produces into one reload. */
const DEBOUNCE_MS = 250;
/** Backoff before re-establishing a watch that failed to open (e.g. mid-rename). */
const REWATCH_RETRY_MS = 500;

/** Live handle onto the hot-reloaded bridge config. */
export interface ConfigStore {
  /**
   * The latest validated config. Read this PER OPERATION (never cache it across
   * awaits) so every policy check / engine run sees the current bridge.toml.
   */
  readonly current: BridgeConfig;
  /** Absolute path of the watched config file (the path loadConfig reads). */
  readonly path: string;
  /** Stop watching and cancel any pending reload (idempotent). */
  stop(): void;
}

/** Top-level config sections we report as "changed" in the reload log. */
const SECTIONS = ['identity', 'room', 'policy', 'filesystem', 'auto'] as const;

/** The absolute path loadConfig() would read for the given --config value. */
export function resolveConfigPath(configPath?: string): string {
  const raw = configPath && configPath.length > 0 ? configPath : DEFAULT_CONFIG_PATH;
  return path.resolve(expandHome(raw));
}

/** Which top-level sections differ between two parsed configs (for the log line). */
function changedSections(prev: BridgeConfig, next: BridgeConfig): string[] {
  const changed: string[] = [];
  for (const s of SECTIONS) {
    if (JSON.stringify(prev[s]) !== JSON.stringify(next[s])) changed.push(s);
  }
  return changed;
}

export interface WatchOptions {
  /** stderr logger (stdout is reserved for the MCP transport). */
  log: (line: string) => void;
  /**
   * Extra validation applied to a freshly loaded config BEFORE it is swapped in.
   * Throw to reject the reload (previous config is kept). The `auto` daemon uses
   * this to require a valid [auto] table so a broken edit never swaps in a
   * config that would then fail per-reply. `mcp` passes none — a broken [auto]
   * table must never disturb the MCP server (contract §13).
   */
  validate?: (cfg: BridgeConfig) => void;
}

/**
 * Load the bridge config once and start watching it for changes. The initial
 * load (and initial `validate`) throw to the caller — a broken config at
 * startup stays fatal, exactly as before; only *reloads* are made non-fatal.
 */
export function startConfigWatcher(configPath: string | undefined, opts: WatchOptions): ConfigStore {
  const resolved = resolveConfigPath(configPath);
  const { log, validate } = opts;

  let currentCfg = loadConfig(configPath);
  if (validate) validate(currentCfg);

  let stopped = false;
  let debounce: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  const reload = (): void => {
    if (stopped) return;
    let next: BridgeConfig;
    try {
      next = loadConfig(configPath);
      if (validate) validate(next);
    } catch (err) {
      log(
        `config reload failed, keeping previous — ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const changed = changedSections(currentCfg, next);
    if (changed.length === 0) return; // file touched but nothing material changed
    currentCfg = next; // atomic swap: a single reference assignment
    log(`config reloaded from ${resolved} — changed section(s): ${changed.join(', ')}`);
  };

  // Editors save via atomic rename (write temp, rename over the target). The
  // original inotify/kqueue watch then points at the replaced/removed inode and
  // stops firing, so on EVERY change event we re-establish the watch on the
  // path (re-open) and then reload from the current file contents.
  const rewatch = (): void => {
    if (stopped) return;
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = null;
    try {
      watcher = fs.watch(resolved, { persistent: false }, () => scheduleReload());
      watcher.on('error', (err) => {
        log(
          `config watch error on ${resolved} (${err instanceof Error ? err.message : String(err)}); re-establishing`,
        );
        retryRewatch();
      });
    } catch (err) {
      // The file can be briefly absent during an atomic rename; retry shortly.
      log(
        `config watch could not open ${resolved} (${err instanceof Error ? err.message : String(err)}); retrying`,
      );
      retryRewatch();
    }
  };

  const retryRewatch = (): void => {
    if (stopped) return;
    const t = setTimeout(() => {
      if (!stopped) rewatch();
    }, REWATCH_RETRY_MS);
    t.unref();
  };

  const scheduleReload = (): void => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      rewatch(); // re-open first (atomic-rename safe), then read the new contents
      reload();
    }, DEBOUNCE_MS);
    debounce.unref();
  };

  rewatch();

  return {
    get current(): BridgeConfig {
      return currentCfg;
    },
    path: resolved,
    stop(): void {
      stopped = true;
      if (debounce) {
        clearTimeout(debounce);
        debounce = null;
      }
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      watcher = null;
    },
  };
}
