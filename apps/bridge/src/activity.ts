/**
 * Automatic agent-activity signaling (docs/API-CONTRACT.md §8, §12).
 *
 * Tracks how many MCP tool executions are in flight and reports the agent's
 * ephemeral activity state over the room WebSocket:
 *
 *   - 0 -> 1 in flight:  {"type":"status","state":"working"}
 *   - back to 0:         {"type":"status","state":"idle"} after a 500 ms
 *                        debounce, so back-to-back tool calls don't flap the
 *                        "working" pill in the web UI.
 *
 * Best-effort by design (contract §12): a failed or dropped status frame must
 * NEVER break a tool call — if the socket is down, tool execution proceeds and
 * no frame is sent. While work is in flight the tracker re-sends `working`
 * every 30 s (the server auto-reverts to idle after
 * DEFAULTS.ACTIVITY_IDLE_TIMEOUT_MS = 60 s without a refresh; a repeated
 * report refreshes the timer without rebroadcasting) and re-asserts `working`
 * after every reconnect, since the server resets a user to idle when their
 * last socket closes.
 *
 * `room_wait_for_new_messages` must NOT be tracked — it is idle waiting and
 * must not flip the state (contract §12).
 */

import type { ActivityState } from '@clausroom/protocol';
import type { RoomSocket } from './client.js';

/** Debounce on the working -> idle edge. */
export const IDLE_DEBOUNCE_MS = 500;
/** Refresh cadence for the `working` report (half the server's 60 s revert). */
const WORKING_REFRESH_MS = 30_000;

export class ActivityTracker {
  private inFlight = 0;
  /** Last state we reported to the server (it assumes idle until told otherwise). */
  private reported: ActivityState = 'idle';
  private idleTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly socket: RoomSocket) {
    // A reconnect resets our server-side activity to idle (last-socket-close
    // rule); re-assert `working` if tool calls are still in flight when the
    // new connection's hello frame arrives.
    this.unsubscribe = socket.onFrame((frame) => {
      if (frame.type === 'hello' && this.inFlight > 0) this.send('working');
    });
  }

  /**
   * Wrap one tool execution with working/idle signaling. The wrapped function's
   * result (or exception) always propagates unchanged — activity signaling can
   * never fail a tool call.
   */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      return await fn();
    } finally {
      this.end();
    }
  }

  /** Stop all timers and the reconnect listener (shutdown). */
  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.clearRefresh();
    this.unsubscribe();
  }

  private begin(): void {
    this.inFlight += 1;
    if (this.idleTimer) {
      // A new call landed inside the idle debounce window: cancel the idle
      // report — the server never saw us go idle, so nothing to re-send.
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.reported !== 'working') this.send('working');
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        if (this.inFlight > 0) this.send('working');
      }, WORKING_REFRESH_MS);
      this.refreshTimer.unref();
    }
  }

  private end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight > 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.inFlight > 0) return; // a call began exactly at the boundary
      this.clearRefresh();
      this.send('idle');
    }, IDLE_DEBOUNCE_MS);
    this.idleTimer.unref();
  }

  private clearRefresh(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
  }

  private send(state: ActivityState): void {
    try {
      this.socket.send({ type: 'status', state });
    } catch {
      /* best-effort: a status failure must never break a tool call */
    }
    this.reported = state;
  }
}
