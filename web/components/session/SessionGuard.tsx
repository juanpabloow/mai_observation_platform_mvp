"use client";

import { useEffect, useRef, useState } from "react";
import { authClient } from "@/lib/auth-client";
import { SESSION_CHANNEL } from "@/lib/accessCopy";
import { formatCountdown, type EndReason } from "@/lib/sessionPolicy";
import { SessionWatcher, type FetchResult, type ServerStatus, type WatcherMessage, type WatcherView } from "@/lib/sessionWatcher";
import { hasUnsavedChanges } from "@/lib/unsavedChanges";

/**
 * Mounted once by the root layout for a signed-in screen. Renders nothing until it matters:
 *   4c/4d  «Tu sesión se cerrará pronto» (idle) — or the absolute-limit variant — 5 min before;
 *          a toast after «Seguir trabajando»;
 *   end    the screen is covered at once (nothing stays readable on a shared computer) and
 *          the browser goes to /login?reason=…&redirect=<this page>, which shows 4e/4f/4i.
 * The rules live in lib/sessionWatcher.ts; the SERVER is the authority (Better Auth's
 * expiresAt), this is the courtesy layer.
 */
async function call(method: "GET" | "POST"): Promise<FetchResult> {
  try {
    const res = await fetch("/api/account/session", { method, credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" } });
    if (res.status === 401) return "ended";
    if (!res.ok) return "offline";
    const j = (await res.json()) as ServerStatus & { state: string };
    return j.state === "active" ? j : "ended";
  } catch {
    return "offline";
  }
}

const ACTIVITY_EVENTS = ["keydown", "pointerdown", "touchstart", "wheel"] as const;

export function SessionGuard({ initial }: { initial: ServerStatus }) {
  const [view, setView] = useState<WatcherView | null>(null);
  const [kept, setKept] = useState(false);
  const [dismissedAbsolute, setDismissedAbsolute] = useState(false);
  const [unsaved, setUnsaved] = useState(false);
  const watcher = useRef<SessionWatcher | null>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(SESSION_CHANNEL);
    } catch {
      channel = null;
    }
    let keptTimer: number | undefined;
    const w = new SessionWatcher(initial, {
      now: () => Date.now(),
      fetchStatus: () => call("GET"),
      reportActivity: () => call("POST"),
      post: (m: WatcherMessage) => channel?.postMessage(m),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (h) => window.clearTimeout(h as number),
      isVisible: () => document.visibilityState === "visible",
      onView: (v) => {
        setView(v);
        // Read once as the warning opens: does a form on this screen hold unsaved changes?
        if (v.phase === "warn") setUnsaved(hasUnsavedChanges());
      },
      onKept: () => {
        setKept(true);
        window.clearTimeout(keptTimer);
        keptTimer = window.setTimeout(() => setKept(false), 4000);
      },
      onEnded: (reason: EndReason | "revoked" | "signed-out", fromPeer: boolean) => {
        const here = `${window.location.pathname}${window.location.search}`;
        const q = new URLSearchParams({ reason });
        if (reason !== "signed-out") q.set("redirect", here);
        const go = () => window.location.replace(`/login?${q.toString()}`);
        // Clear this browser's cookie (the server already dropped the session); never wait long.
        if (fromPeer) go();
        else void Promise.race([authClient.signOut().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]).then(go);
      },
    });
    watcher.current = w;
    w.start();

    const onActivity = (e: Event) => {
      if (e.isTrusted) w.interaction();
    };
    for (const t of ACTIVITY_EVENTS) window.addEventListener(t, onActivity, { capture: true, passive: true });
    const onWake = () => {
      if (document.visibilityState === "visible") void w.wake();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("online", onWake);
    window.addEventListener("pageshow", onWake);
    const onMessage = (e: MessageEvent<WatcherMessage | { type: string }>) => {
      const m = e.data;
      if (m && (m.type === "status" || m.type === "ended")) w.receive(m as WatcherMessage);
    };
    channel?.addEventListener("message", onMessage);

    return () => {
      w.stop();
      for (const t of ACTIVITY_EVENTS) window.removeEventListener(t, onActivity, { capture: true });
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("online", onWake);
      window.removeEventListener("pageshow", onWake);
      channel?.removeEventListener("message", onMessage);
      channel?.close();
      window.clearTimeout(keptTimer);
    };
    // The initial status is read ONCE; later truth comes from the server through the watcher.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const warn = view?.phase === "warn" && !(view.reason !== "idle" && dismissedAbsolute);
  const ended = view?.phase === "ended";

  // Opening the warning: focus its main action.
  useEffect(() => {
    if (!warn) return;
    const t = window.setTimeout(() => primary.current?.focus({ preventScroll: true }), 30);
    return () => window.clearTimeout(t);
  }, [warn]);

  // Keep keyboard focus inside the alert dialog (Tab cycles its two buttons).
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "Tab") return;
    const items = dialog.current?.querySelectorAll<HTMLElement>("button, a[href]");
    if (!items || items.length === 0) return;
    const firstEl = items[0]!;
    const lastEl = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === firstEl) {
      e.preventDefault();
      lastEl.focus();
    } else if (!e.shiftKey && document.activeElement === lastEl) {
      e.preventDefault();
      firstEl.focus();
    }
  }

  if (ended) {
    return (
      <div className="u-session-layer fixed inset-0 z-[100] flex items-center justify-center bg-background p-6" role="status">
        <p className="text-sm text-muted">Tu sesión se cerró. Te llevamos a la pantalla de inicio…</p>
      </div>
    );
  }

  const countdown = formatCountdown(view?.remainingMs ?? 0);
  const minutesLeft = Math.max(1, Math.ceil((view?.remainingMs ?? 0) / 60_000));
  const idle = view?.reason === "idle";

  return (
    <>
      {warn ? (
        <div className="u-session-layer fixed inset-0 z-[90] flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
          <div
            ref={dialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="session-warn-title"
            aria-describedby="session-warn-body"
            onKeyDown={onKeyDown}
            className="flex w-full flex-col gap-3.5 rounded-t-[20px] bg-popover px-5 pb-[calc(20px+env(safe-area-inset-bottom))] pt-3 text-popover-foreground shadow-[0_12px_40px_rgba(0,0,0,.18)] sm:max-w-[400px] sm:rounded-[14px] sm:p-6"
          >
            <span aria-hidden className="h-1 w-9 self-center rounded-sm bg-line-strong sm:hidden" />
            <h2 id="session-warn-title" className="m-0 text-xl font-semibold tracking-[-.01em]">
              {idle ? "Tu sesión se cerrará pronto" : "Tu sesión terminará pronto"}
            </h2>
            <p id="session-warn-body" className="m-0 text-base leading-normal text-foreground/80 sm:text-[15px]">
              {idle ? (
                <>
                  No detectamos actividad en casi 2 horas. Cerraremos la sesión en{" "}
                  <span className="font-mono text-foreground">{countdown}</span> para proteger la cuenta.
                </>
              ) : view?.reason === "max" ? (
                <>
                  Las sesiones sin «Mantener sesión» duran como máximo 12 horas. Se cerrará en{" "}
                  <span className="font-mono text-foreground">{countdown}</span>; después tendrás que volver a entrar.
                </>
              ) : (
                <>
                  Se cumplen 30 días desde que elegiste mantener la sesión. Se cerrará en{" "}
                  <span className="font-mono text-foreground">{countdown}</span>; después tendrás que volver a entrar.
                </>
              )}
            </p>
            {/* Announce once a minute, not every second. */}
            <span className="sr-only" aria-live="polite">
              {`Quedan ${minutesLeft} ${minutesLeft === 1 ? "minuto" : "minutos"}.`}
            </span>
            <p className="m-0 text-[13px] leading-[1.45] text-muted">
              {unsaved
                ? "Tienes cambios sin guardar en esta pantalla. Guárdalos antes: si la sesión se cierra, no se conservan."
                : "Si estás editando algo, guárdalo antes: los cambios sin guardar no se conservan."}
              {idle ? " Las actualizaciones automáticas de Inbox o Agenda no cuentan como actividad." : ""}
            </p>
            <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse sm:justify-start">
              {idle ? (
                <button
                  ref={primary}
                  type="button"
                  onClick={() => void watcher.current?.keepWorking()}
                  className="u-focus h-12 rounded-xl bg-ink px-[18px] text-base font-semibold text-ink-fg hover:bg-ink-hover sm:h-11 sm:rounded-[10px] sm:text-[15px]"
                >
                  Seguir trabajando
                </button>
              ) : (
                <button
                  ref={primary}
                  type="button"
                  onClick={() => setDismissedAbsolute(true)}
                  className="u-focus h-12 rounded-xl bg-ink px-[18px] text-base font-semibold text-ink-fg hover:bg-ink-hover sm:h-11 sm:rounded-[10px] sm:text-[15px]"
                >
                  Entendido
                </button>
              )}
              <a
                href="/logout"
                className="u-focus flex h-12 items-center justify-center rounded-xl border border-line-strong bg-surface px-4 text-base text-foreground hover:bg-subtle sm:h-11 sm:rounded-[10px] sm:text-[15px]"
              >
                Cerrar sesión
              </a>
            </div>
          </div>
        </div>
      ) : null}
      {kept ? (
        <div
          role="status"
          className="u-session-layer fixed bottom-7 left-1/2 z-[90] -translate-x-1/2 whitespace-nowrap rounded-[10px] bg-[#1C1D20] px-4 py-3 text-sm text-[#ECECEE] shadow-lg"
        >
          Sigues conectado. El contador se reinició.
        </div>
      ) : null}
    </>
  );
}
