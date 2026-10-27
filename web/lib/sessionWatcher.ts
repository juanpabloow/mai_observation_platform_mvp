/**
 * SESSION WATCHER — the browser half of the session policy, framework-free so it is tested
 * with a controlled clock and fake tabs (test/unit/sessionWatcher.test.ts). The React
 * wrapper is components/session/SessionGuard.tsx.
 *
 * It never DECIDES anything the server has not: the deadline it shows is the server's
 * (`expiresAt` from /api/account/session, adjusted for clock skew), and when it reaches it,
 * it asks the server before ending. What it adds is courtesy and hygiene:
 *   - the 5-minute warning, «Seguir trabajando» (restarts the idle clock, never the 12 h);
 *   - reporting REAL interaction (keyboard / click / touch / wheel, trusted events only) at
 *     most once a minute — timers, polling and background fetches never call `interaction`;
 *   - TABS agree through a BroadcastChannel: one tab's activity moves every tab's deadline,
 *     a sign-out or an expiry in one closes all of them;
 *   - a SLEEPING laptop or a throttled background tab: every check uses the wall clock, and
 *     waking up (visibility, focus, online) re-reads the server before trusting anything;
 *   - a session closed ELSEWHERE (Seguridad → Sesiones, an admin, a password reset) is
 *     noticed by the periodic read-only check and ends the tab as «revocada».
 */
import { ACTIVITY_REPORT_INTERVAL_MS, WARNING_LEAD_MS, endReason, type EndReason } from "./sessionPolicy";

export interface ServerStatus {
  expiresAt: number;
  absoluteExpiresAt: number;
  persistent: boolean;
  serverNow: number;
}
export type FetchResult = ServerStatus | "ended" | "offline";

export type WatcherMessage =
  | { type: "status"; status: ServerStatus }
  | { type: "ended"; reason: EndReason | "revoked" | "signed-out" }
  | { type: "signed-in" };

export interface WatcherView {
  phase: "ok" | "warn" | "ended";
  /** Why the deadline would end the session (warning copy). */
  reason: EndReason;
  /** ms until the deadline (local clock), ≥ 0. */
  remainingMs: number;
  /** Set when phase === "ended". */
  endedBy: EndReason | "revoked" | "signed-out" | null;
}

export interface WatcherDeps {
  now(): number;
  fetchStatus(): Promise<FetchResult>;
  reportActivity(): Promise<FetchResult>;
  post(msg: WatcherMessage): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Background tabs skip the periodic revocation check (they re-check on wake). */
  isVisible(): boolean;
  onView(view: WatcherView): void;
  /** «Seguir trabajando» worked. */
  onKept?(): void;
  /** The session is over: leave (sign-out cleanup + /login?reason=…). */
  onEnded(reason: EndReason | "revoked" | "signed-out", fromPeer: boolean): void;
}

/** How often a visible tab re-reads the deadline (revocations, other tabs, skew). */
export const STATUS_POLL_MS = 60_000;

export class SessionWatcher {
  private skew = 0;
  private s: ServerStatus;
  private timer: unknown = null;
  private poll: unknown = null;
  private lastReport = -Infinity;
  private inflight: Promise<void> | null = null;
  private ended: WatcherView["endedBy"] = null;
  private stopped = false;

  constructor(initial: ServerStatus, private d: WatcherDeps) {
    this.s = initial;
    this.skew = initial.serverNow - d.now();
  }

  start(): void {
    this.stopped = false;
    this.schedule();
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    if (this.poll !== null) this.d.clearTimer(this.poll);
    this.timer = this.poll = null;
  }

  /** The deadline in LOCAL time. */
  get deadline(): number {
    return this.s.expiresAt - this.skew;
  }

  view(): WatcherView {
    const remainingMs = Math.max(0, this.deadline - this.d.now());
    const reason = endReason({
      persistent: this.s.persistent,
      absoluteExpiresAt: new Date(this.s.absoluteExpiresAt),
      expiresAt: new Date(this.s.expiresAt),
    });
    const phase = this.ended ? "ended" : remainingMs <= WARNING_LEAD_MS ? "warn" : "ok";
    return { phase, reason, remainingMs, endedBy: this.ended };
  }

  /** A trusted keyboard / pointer / touch / wheel event from the person. */
  interaction(): void {
    if (this.ended || this.stopped || this.s.persistent) return;
    // While the warning is up only the explicit «Seguir trabajando» counts.
    if (this.view().phase === "warn") return;
    if (this.d.now() - this.lastReport < ACTIVITY_REPORT_INTERVAL_MS) return;
    void this.report(false);
  }

  /** «Seguir trabajando». */
  keepWorking(): Promise<void> {
    return this.report(true);
  }

  /** Visibility regained / focus / back online / page restored from bfcache. */
  wake(): Promise<void> {
    return this.resync();
  }

  receive(msg: WatcherMessage): void {
    if (this.stopped) return;
    if (msg.type === "status") {
      if (this.ended) return;
      // Another tab learned a newer deadline (its activity, its «Seguir trabajando»).
      if (msg.status.expiresAt !== this.s.expiresAt) this.apply(msg.status, false);
    } else if (msg.type === "ended") {
      this.end(msg.reason, true);
    }
  }

  private async report(explicit: boolean): Promise<void> {
    if (this.inflight) return this.inflight;
    this.lastReport = this.d.now();
    const run = (async () => {
      const r = await this.d.reportActivity();
      if (r === "offline") return;
      if (r === "ended") return this.handleGone();
      this.apply(r, true);
      if (explicit) this.d.onKept?.();
    })();
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async resync(): Promise<void> {
    if (this.ended || this.stopped) return;
    const r = await this.d.fetchStatus();
    if (r === "offline") return this.schedule();
    if (r === "ended") return this.handleGone();
    this.apply(r, false);
  }

  private apply(status: ServerStatus, broadcast: boolean): void {
    this.s = status;
    this.skew = status.serverNow - this.d.now();
    if (broadcast) this.d.post({ type: "status", status });
    this.schedule();
  }

  /** The server no longer knows this session: did it run out, or was it closed? */
  private handleGone(): void {
    const ranOut = this.d.now() >= this.deadline - 1_000;
    this.end(ranOut ? this.view().reason : "revoked", false);
  }

  private end(reason: NonNullable<WatcherView["endedBy"]>, fromPeer: boolean): void {
    if (this.ended) return;
    this.ended = reason;
    this.stop();
    if (!fromPeer) this.d.post({ type: "ended", reason });
    this.d.onView(this.view());
    this.d.onEnded(reason, fromPeer);
  }

  private schedule(): void {
    if (this.stopped || this.ended) return;
    if (this.timer !== null) this.d.clearTimer(this.timer);
    const remaining = this.deadline - this.d.now();
    this.d.onView(this.view());
    if (remaining <= 0) {
      // Never end on the local clock alone: the server decides (another tab may have
      // extended it a second ago).
      this.timer = null;
      void this.resync();
      return;
    }
    // Inside the warning: tick every second for the countdown; before it: wake at its start.
    const wait = remaining <= WARNING_LEAD_MS ? Math.min(1_000, remaining) : remaining - WARNING_LEAD_MS;
    this.timer = this.d.setTimer(() => {
      this.timer = null;
      this.schedule();
    }, wait);
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    this.poll = this.d.setTimer(() => {
      this.poll = null;
      if (this.d.isVisible()) void this.resync();
      this.schedulePoll();
    }, STATUS_POLL_MS);
  }
}
