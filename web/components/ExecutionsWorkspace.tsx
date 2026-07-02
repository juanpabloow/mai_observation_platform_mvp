"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Master-detail shell for the executions page, under the FIXED app shell. It fills
 * the workflow layout's bounded slot (flex-1 min-h-0) and, on desktop, splits into
 * two INDEPENDENTLY-SCROLLING columns: the table column (left) and a resizable
 * DETAIL PANEL (right, when ?execution=<id> is set). Scrolling one never moves the
 * other or the page; the chat box inside the panel keeps its own inner scroll.
 * On mobile it collapses to a single scrolling column (table, then panel below).
 *
 *  - Because this lives ON the executions page, the breadcrumb + sidebar never
 *    change while viewing an execution (the old /executions/[id] nav bug is gone).
 *  - RESIZABLE: drag the divider (which is also the visible panel BOUNDARY — a
 *    full-height line); width clamped to [MIN, min(HARD_MAX, container − MIN_TABLE)],
 *    re-clamped on container resize, persisted to localStorage.
 *  - The panel is an `@container`, so its own width decides whether the
 *    conversation sits beside or above the nodes — dragging re-decides.
 *  - CLOSE (✕) drops ?execution (scroll:false). Auto-refresh uses router.refresh(),
 *    which preserves client state + scroll, so the open panel isn't disturbed.
 */

const MIN_WIDTH = 360;
const HARD_MAX_WIDTH = 880;
const DEFAULT_WIDTH = 460;
const MIN_TABLE_WIDTH = 360;
const STORAGE_KEY = "execPanelWidth";

function clampWidth(w: number, containerWidth: number): number {
  const ceiling = Math.min(
    HARD_MAX_WIDTH,
    Math.max(MIN_WIDTH, (containerWidth || Number.POSITIVE_INFINITY) - MIN_TABLE_WIDTH),
  );
  return Math.min(Math.max(w, MIN_WIDTH), ceiling);
}

export function ExecutionsWorkspace({
  children,
  panel,
}: {
  children: React.ReactNode;
  panel: React.ReactNode | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const open = panel != null;

  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);
  const drag = useRef({ startX: 0, startWidth: 0, containerWidth: 0 });

  // Restore the persisted width (clamped to the current container) after mount —
  // keeps SSR/first-paint at DEFAULT_WIDTH so there's no hydration mismatch.
  useEffect(() => {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      const cw = containerRef.current?.getBoundingClientRect().width ?? 0;
      setWidth(clampWidth(stored, cw));
    }
  }, []);

  // Never let the panel crowd the table out when the viewport/container shrinks.
  useEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      setWidth((w) => clampWidth(w, el.getBoundingClientRect().width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = {
      startX: e.clientX,
      startWidth: width,
      containerWidth: containerRef.current?.getBoundingClientRect().width ?? 0,
    };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    // The panel is on the RIGHT, so dragging the divider LEFT widens it.
    const delta = drag.current.startX - e.clientX;
    setWidth(clampWidth(drag.current.startWidth + delta, drag.current.containerWidth));
  };
  const endDrag = (e: React.PointerEvent) => {
    if (!dragging) return;
    setDragging(false);
    e.currentTarget.releasePointerCapture(e.pointerId);
    window.localStorage.setItem(STORAGE_KEY, String(Math.round(width)));
  };

  const close = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("execution");
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  // Root fills the bounded slot. Mobile: one scrolling column (overflow-y-auto).
  // Desktop: a non-scrolling flex row whose columns each scroll independently.
  const rootClass =
    "mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col overflow-y-auto px-6 md:flex-row md:overflow-hidden" +
    (dragging ? " select-none" : "");

  if (!open) {
    return (
      <div ref={containerRef} className={rootClass}>
        <div className="min-w-0 py-6 md:min-h-0 md:flex-1 md:overflow-y-auto">{children}</div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={rootClass}>
      {/* LEFT — table column, scrolls independently on desktop. */}
      <div className="min-w-0 py-6 md:min-h-0 md:flex-1 md:overflow-y-auto md:pr-4">{children}</div>

      {/* DIVIDER — the visible panel boundary (full-height line) that also drags. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="group relative hidden w-4 shrink-0 cursor-col-resize touch-none md:block"
      >
        <span
          className={`absolute inset-y-0 left-1/2 -ml-px w-0.5 transition-colors ${
            dragging ? "bg-accent" : "bg-line group-hover:bg-accent"
          }`}
        />
        <span
          className={`absolute left-1/2 top-1/2 h-10 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${
            dragging ? "bg-accent" : "bg-line-strong group-hover:bg-accent"
          }`}
        />
      </div>

      {/* PANEL — scrolls independently; @container drives its inner conv layout. */}
      <aside
        style={{ width }}
        className="@container w-full shrink-0 py-6 max-md:!w-full md:min-h-0 md:min-w-0 md:overflow-y-auto md:pl-4"
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Execution detail
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close detail panel"
            className="rounded-lg border border-black/10 px-2 py-1 text-xs text-muted transition-colors hover:bg-black/[0.04] hover:text-foreground dark:border-line-strong dark:hover:bg-subtle"
          >
            ✕
          </button>
        </div>
        {panel}
      </aside>
    </div>
  );
}
