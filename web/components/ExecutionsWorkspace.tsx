"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Master-detail shell for the executions page. The table (+ its controls +
 * pagination) is the LEFT column; when a row is opened (?execution=<id> → the
 * page server-renders `panel`), a resizable DETAIL PANEL appears on the RIGHT.
 * Because this lives ON the executions page, the breadcrumb + sidebar never
 * change while viewing an execution (the old /executions/[id] nav-context bug is
 * gone) — for owners, admins, AND members alike.
 *
 *  - RESIZABLE: drag the divider (pointer-capture); width is clamped to
 *    [MIN, min(HARD_MAX, container − MIN_TABLE)] so the table always keeps room,
 *    re-clamped on container resize, and persisted to localStorage.
 *  - The panel is an `@container`, so its own width (not the viewport) decides
 *    whether the conversation sits beside or above the nodes — dragging re-decides.
 *  - CLOSE (✕) just drops ?execution (scroll:false); opening/closing/swapping are
 *    plain URL changes, so a bookmarked ?execution=<id> opens the panel directly.
 *  - Auto-refresh of the table beneath uses router.refresh(), which preserves
 *    client state + scroll, so the open panel doesn't flicker/close/reset.
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

  if (!open) {
    return <div ref={containerRef}>{children}</div>;
  }

  return (
    <div
      ref={containerRef}
      className={`flex flex-col md:flex-row md:items-start ${dragging ? "select-none" : ""}`}
    >
      <div className="min-w-0 flex-1">{children}</div>

      {/* Drag divider (desktop). touch-none so a touch-drag resizes, not scrolls. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize detail panel"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="group hidden shrink-0 cursor-col-resize touch-none items-center justify-center self-stretch px-1.5 md:flex"
      >
        <span
          className={`h-10 w-1 rounded-full transition-colors ${
            dragging ? "bg-accent" : "bg-line-strong group-hover:bg-accent"
          }`}
        />
      </div>

      {/* Detail panel. @container → the panel's own width drives its inner layout. */}
      <aside
        style={{ width }}
        className="@container w-full shrink-0 max-md:!w-full md:min-w-0"
      >
        <div className="mb-3 flex items-center justify-between gap-2 max-md:mt-6">
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
