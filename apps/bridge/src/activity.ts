/**
 * The "working" pill. Reports `working` while at least one tool call is in
 * flight and `idle` shortly after the last one finishes, so back-to-back calls
 * do not make it flicker.
 *
 * Entirely best-effort: a dropped frame must never fail the tool call it
 * describes. `room_wait_for_new_messages` deliberately is not tracked — waiting
 * is not working.
 */
import type { ActivityState } from '@clausroom/protocol';
import type { Feed } from './client.js';

const IDLE_DEBOUNCE_MS = 500;
/** Half the server's idle timeout, so a long run keeps the pill alive. */
const REFRESH_MS = 30_000;

export class Activity {
  private inFlight = 0;
  private reported: ActivityState = 'idle';
  private idle: NodeJS.Timeout | null = null;
  private refresh: NodeJS.Timeout | null = null;
  private readonly unsubscribe: () => void;

  constructor(private readonly feed: Feed) {
    // A reconnect resets us to idle server-side; re-assert if work continues.
    this.unsubscribe = feed.on((frame) => {
      if (frame.type === 'hello' && this.inFlight > 0) this.report('working');
    });
  }

  /** Wrap one tool call. Its result — or its exception — passes through intact. */
  async track<T>(fn: () => Promise<T>): Promise<T> {
    this.begin();
    try {
      return await fn();
    } finally {
      this.end();
    }
  }

  stop(): void {
    if (this.idle) clearTimeout(this.idle);
    if (this.refresh) clearInterval(this.refresh);
    this.unsubscribe();
  }

  private begin(): void {
    this.inFlight += 1;
    if (this.idle) {
      // A new call arrived inside the debounce window; the server never saw idle.
      clearTimeout(this.idle);
      this.idle = null;
    }
    if (this.reported !== 'working') this.report('working');
    if (!this.refresh) {
      this.refresh = setInterval(() => {
        if (this.inFlight > 0) this.report('working');
      }, REFRESH_MS);
      this.refresh.unref();
    }
  }

  private end(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (this.inFlight > 0 || this.idle) return;
    this.idle = setTimeout(() => {
      this.idle = null;
      if (this.inFlight > 0) return;
      if (this.refresh) clearInterval(this.refresh);
      this.refresh = null;
      this.report('idle');
    }, IDLE_DEBOUNCE_MS);
    this.idle.unref();
  }

  private report(state: ActivityState): void {
    this.feed.send({ type: 'status', state });
    this.reported = state;
  }
}
