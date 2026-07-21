"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The ONE shared side pane (H-8.2) used by BOTH the inbox conversation drawer and the
 * execution-detail pane. It is:
 *
 *  - NON-MODAL: no backdrop, no scroll-lock. On desktop it sits BELOW the app header
 *    (measured) as a right-aligned column, so the header / sidebar / grid / table
 *    behind it stay fully visible and interactive (click another card/row to switch
 *    the pane in place; apply a filter and the grid responds behind it).
 *  - RESIZABLE: drag the left-edge handle; width clamped to [MIN, min(HARD_MAX,
 *    65vw)] and persisted per pane type in localStorage (the clamp + pointer-drag +
 *    persist pattern is the one the old executions split-pane used).
 *  - STICKY HEADER (optional): when `header` is given, the pane renders a pinned
 *    header bar (header content + the ✕) above a scrolling body — so the ✕ is always
 *    reachable no matter how far the body scrolls. When `header` is omitted the child
 *    owns its own header/scroll/footer (the inbox thread already does this correctly).
 *  - MOBILE (<md): a full-screen sheet (resize + the desktop top-offset don't apply).
 *
 * Closing (the ✕ when the pane owns the header, or Esc) calls `onClose` — the caller
 * drops its deep-link param (?c= / ?execution=), which is what actually unmounts it.
 */

const MIN_WIDTH = 380;
const HARD_MAX_WIDTH = 1100;
const DEFAULT_WIDTH = 480;
const MAX_VW = 0.65;

function clampWidth(w: number): number {
  const vw = typeof window === "undefined" ? Number.POSITIVE_INFINITY : window.innerWidth;
  const ceiling = Math.min(HARD_MAX_WIDTH, Math.max(MIN_WIDTH, vw * MAX_VW));
  return Math.min(Math.max(w, MIN_WIDTH), ceiling);
}

export function SidePane({
  paneType,
  onClose,
  header,
  children,
}: {
  /** Distinguishes the persisted width per pane. */
  paneType: "inbox" | "execution";
  onClose: () => void;
  /** When set, the pane renders a sticky header bar (this + ✕) over a scrolling body. */
  header?: React.ReactNode;
  children: React.ReactNode;
}) {
  const storageKey = `sidePaneWidth:${paneType}`;
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const [headerH, setHeaderH] = useState(53); // app header height; corrected on mount
  const drag = useRef({ startX: 0, startWidth: 0 });

  // Restore the persisted width (clamped) after mount — SSR/first paint stay at
  // DEFAULT_WIDTH so there's no hydration mismatch.
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(storageKey));
    if (Number.isFinite(stored) && stored > 0) setWidth(clampWidth(stored));
  }, [storageKey]);

  // Measure the app header so the desktop pane starts right below it (keeps the
  // header/breadcrumb/account menu fully usable — the pane is non-modal). Runs
  // before paint to avoid a jump, and re-measures on resize.
  useLayoutEffect(() => {
    const measure = () => {
      const el = document.querySelector("header");
      if (el) setHeaderH(Math.round(el.getBoundingClientRect().height));
      setWidth((w) => clampWidth(w)); // re-clamp against the new 65vw ceiling
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { startX: e.clientX, startWidth: width };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    // Handle is on the LEFT edge → dragging left widens the pane.
    setWidth(clampWidth(drag.current.startWidth + (drag.current.startX - e.clientX)));
  };
  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      setDragging(false);
      e.currentTarget.releasePointerCapture(e.pointerId);
      window.localStorage.setItem(storageKey, String(Math.round(width)));
    },
    [dragging, width, storageKey],
  );

  return (
    <aside
      style={
        {
          "--pane-top": `${headerH}px`,
          "--pane-w": `${width}px`,
        } as React.CSSProperties
      }
      className={`fixed inset-0 z-40 flex w-full flex-col border-l border-line bg-background shadow-2xl md:bottom-0 md:left-auto md:right-0 md:top-[var(--pane-top)] md:w-[var(--pane-w)] md:max-w-[65vw] md:min-w-[380px] ${
        dragging ? "select-none" : ""
      }`}
      role="dialog"
      aria-label={header ? undefined : "Side pane"}
    >
      {/* Left-edge resize handle (desktop only). */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize pane"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="group absolute inset-y-0 left-0 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none md:block"
      >
        <span
          className={`absolute inset-y-0 left-1/2 -ml-px w-0.5 transition-colors ${
            dragging ? "bg-accent" : "bg-transparent group-hover:bg-accent/60"
          }`}
        />
      </div>

      {header ? (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-3">
            <div className="flex min-w-0 items-center gap-2">{header}</div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close pane"
              className="shrink-0 rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
            >
              ✕
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        </>
      ) : (
        // Child owns its own sticky header / scroll / footer (e.g. InboxThread).
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      )}
    </aside>
  );
}
