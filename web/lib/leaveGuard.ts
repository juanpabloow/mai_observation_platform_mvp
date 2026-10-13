/**
 * LEAVE GUARD — the pure core behind "¿Descartar los cambios?" for a form that lives in
 * component state (not in the URL). Unit-tested with a fake history
 * (test/unit/leaveGuard.test.ts); the React wrapper is components/ui/useLeaveGuard.ts.
 *
 * Every way out of the form goes through it — Cancelar, Cerrar, the scrim, Escape and the
 * browser / system BACK:
 *   - no real changes  → leave at once, no question;
 *   - real changes     → ask (`onAsk`); "Seguir editando" keeps the draft, "Descartar"
 *                        leaves without saving anything.
 *
 * BACK. A state form has no URL of its own, so Back would sail past it to the previous
 * page and lose the draft silently. Arming adds ONE same-URL history entry carrying a
 * marker (the pattern AgendaView's phone booking uses). Back then pops that entry: if
 * dirty, the guard asks and re-adds the marker (so the history does not grow); if clean,
 * it simply leaves. Leaving from the UI removes the marker first (`history.back()`), so
 * closing the form never leaves a ghost entry that makes the next Back do nothing.
 */

export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  back(): void;
}

export interface PopEvents {
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface LeaveGuard {
  /** Add the marker entry and start listening for Back. Call once, when the form opens. */
  arm(): void;
  /** Cancelar / Cerrar / scrim / Escape: ask when dirty, otherwise leave. */
  requestLeave(): void;
  /** Leave NOW (Descartar, or after a successful save): drop the marker, then onLeave. */
  leave(): void;
  /** Stop listening; removes the marker if it is still the current entry. */
  dispose(): void;
}

let seq = 0;

export function createLeaveGuard(opts: {
  history: HistoryLike;
  events: PopEvents;
  isDirty: () => boolean;
  onAsk: () => void;
  onLeave: () => void;
  /** The key the marker is stored under in history.state. */
  key?: string;
}): LeaveGuard {
  const KEY = opts.key ?? "__leaveGuard";
  const id = `g${++seq}`;
  let leaving = false;
  let disposed = false;
  let left = false;
  let pendingLeave: (() => void) | null = null;

  const stateObj = (): Record<string, unknown> =>
    opts.history.state && typeof opts.history.state === "object" ? (opts.history.state as Record<string, unknown>) : {};
  const isOurs = () => stateObj()[KEY] === id;
  // Spread the existing state: the framework router keeps its own data there.
  const mark = () => opts.history.pushState({ ...stateObj(), [KEY]: id }, "");

  const finish = () => {
    if (left || disposed) return;
    left = true;
    opts.onLeave();
  };

  const onPop = () => {
    if (leaving || disposed || left) return; // our own back(), or already gone
    if (opts.isDirty()) {
      mark(); // re-arm: the history length stays the same
      opts.onAsk();
    } else {
      finish();
    }
  };

  const leave = () => {
    if (left || leaving || disposed) return;
    if (!isOurs()) return finish();
    leaving = true;
    const done = () => {
      opts.events.removeEventListener("popstate", done);
      pendingLeave = null;
      finish();
    };
    pendingLeave = done;
    opts.events.addEventListener("popstate", done);
    opts.history.back();
  };

  return {
    arm() {
      if (disposed) return;
      opts.events.addEventListener("popstate", onPop);
      if (!isOurs()) mark();
    },
    requestLeave() {
      if (left || disposed) return;
      if (opts.isDirty()) opts.onAsk();
      else leave();
    },
    leave,
    dispose() {
      if (disposed) return;
      disposed = true;
      opts.events.removeEventListener("popstate", onPop);
      if (pendingLeave) {
        opts.events.removeEventListener("popstate", pendingLeave);
        pendingLeave = null;
      }
      if (!leaving && isOurs()) {
        leaving = true;
        opts.history.back();
      }
    },
  };
}
