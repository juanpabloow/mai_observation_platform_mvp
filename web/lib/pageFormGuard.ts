import { createLeaveGuard, type HistoryLike, type LeaveGuard, type PopEvents } from "./leaveGuard";

/**
 * PAGE FORM GUARD — the pure core of usePageFormGuard (components/ui/module/useEditorGuard)
 * for a settings form that IS the page (Reglas de reserva, the public contact and the
 * public categories of Página de reservas). Unit-tested against a fake browser history
 * (test/unit/pageFormGuard.test.ts); the hook only feeds it React state and the router.
 *
 * While the form has changes:
 *   - browser / system BACK asks first: a one-entry history marker (lib/leaveGuard) is
 *     added when the form becomes dirty — never while it is clean;
 *   - a link anywhere in the app asks first (the hook intercepts it and calls askLink).
 * «Seguir editando» keeps the draft and the page; «Descartar» finishes what was asked —
 * the Back or the link — exactly once.
 *
 * When the form becomes CLEAN on the same page (saved, or its own «Descartar cambios»),
 * the marker entry goes too, so the next Back leaves the page instead of landing on a
 * same-URL copy of it. A save's router refresh may rewrite history.state and drop the
 * marker key; the entry is then popped by URL (still on the page the marker was added on).
 */

const KEY = "__pageFormGuard";

export interface PageFormGuard {
  /** Feed the form's dirty state on every change. */
  setDirty(dirty: boolean): void;
  /** A link was intercepted while dirty: ask, and remember to follow it on «Descartar». */
  askLink(): void;
  /** «Seguir editando». */
  keepEditing(): void;
  /** «Descartar»: finish the Back or the link that was asked about. */
  discard(): void;
  /** The form is going away (unmount). */
  dispose(): void;
}

export function createPageFormGuard(opts: {
  history: HistoryLike;
  events: PopEvents;
  /** The current URL's pathname (window.location.pathname). */
  pathname: () => string;
  /** Show the «¿Descartar los cambios?» question. */
  onAsk: () => void;
  /** Finish the intercepted link (router.push of the remembered href). */
  followLink: () => void;
}): PageFormGuard {
  let dirty = false;
  let guard: LeaveGuard | null = null;
  let armedPath = "";
  let left = false;
  let reason: "back" | "link" | null = null;

  const arm = () => {
    left = false;
    armedPath = opts.pathname();
    guard = createLeaveGuard({
      history: opts.history,
      events: opts.events,
      key: KEY,
      isDirty: () => dirty,
      onAsk: () => {
        reason = "back";
        opts.onAsk();
      },
      // Runs once the marker is gone: complete what the person was doing.
      onLeave: () => {
        left = true;
        const why = reason;
        reason = null;
        if (why === "back") opts.history.back();
        else if (why === "link") opts.followLink();
      },
    });
    guard.arm();
  };

  const release = () => {
    if (!guard) return;
    const g = guard;
    guard = null;
    const state = opts.history.state as Record<string, unknown> | null;
    const carriesKey = Boolean(state && typeof state === "object" && state[KEY]);
    g.dispose(); // pops the marker entry when it still carries the key
    // The key was stripped (router refresh) but we never left this page: pop it by URL.
    if (!carriesKey && !left && opts.pathname() === armedPath) opts.history.back();
  };

  return {
    setDirty(next) {
      if (next === dirty) return;
      dirty = next;
      if (dirty) arm();
      else release();
    },
    askLink() {
      reason = "link";
      opts.onAsk();
    },
    keepEditing() {
      reason = null;
    },
    discard() {
      if (guard) guard.leave();
      else if (reason === "link") {
        reason = null;
        opts.followLink();
      }
    },
    dispose: release,
  };
}
