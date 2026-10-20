"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RAIL_ACTIVE, RAIL_H, RAIL_IDLE, RAIL_ROW } from "@/components/railRow";

const POLL_MS = 5000;

/**
 * A sidebar nav item with a live pending-count badge (the client-level aggregated
 * pending count). Polls on mount and every ~5s, paused while the tab is hidden.
 *
 * Renders to match the sidebar's other nav items and supports the rail's two states:
 *   - expanded: icon + label, the pending count as a small red pill on the right;
 *   - collapsed (`collapsed`): icon only, centered, with a tooltip on hover/focus, the
 *     count folded into the accessible name and a compact pill over the icon.
 */
export function InboxTabLink({
  href,
  active,
  countEndpoint,
  label = "Inbox",
  icon,
  collapsed = false,
  onNavigate,
}: {
  href: string;
  active: boolean;
  countEndpoint: string;
  label?: string;
  icon?: ReactNode;
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(countEndpoint, { cache: "no-store" });
      if (!res.ok) return;
      const payload: { pendingCount?: number } = await res.json();
      if (typeof payload.pendingCount === "number") setCount(payload.pendingCount);
    } catch {
      /* keep last-known count */
    }
  }, [countEndpoint]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (!timer) timer = setInterval(() => void load(), POLL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") stop();
      else {
        void load();
        start();
      }
    };
    if (document.visibilityState === "visible") {
      // load() is async — setCount runs only after the fetch resolves, not
      // synchronously in the effect body (the lint rule can't see through it).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void load();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  // The SAME row as every other rail row, from the SAME constant — see the note on
  // RAIL_ROW in components/railRow.ts. Imported rather than re-typed: the row height is
  // exactly what drifts when two components spell it out separately.
  const base = `${RAIL_ROW} ${RAIL_H} ${
    collapsed ? "justify-center px-0" : "gap-2.5 pl-2.5 pr-1"
  } ${active ? RAIL_ACTIVE : RAIL_IDLE} ${collapsed ? "u-rail-tip" : ""}`;
  // The count itself (proposal): a small red pill; on the red active row it turns white so
  // it never disappears into the pill.
  const pill = `flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11.5px] font-semibold tabular-nums ${
    active ? "bg-white text-nav-active" : "bg-nav-active text-white"
  }`;

  // Collapsed: icon only, tooltip + count folded into the accessible name; a small dot
  // signals pending without a number (there's no room for the badge).
  if (collapsed) {
    return (
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        aria-label={count > 0 ? `${label}, ${count} pendientes` : label}
        data-tip={count > 0 ? `${label} · ${count} pendientes` : label}
        className={base}
      >
        {icon ? <span className="shrink-0" aria-hidden>{icon}</span> : <span>{label}</span>}
        {count > 0 ? (
          <span aria-hidden className={`absolute right-1 top-0.5 ${pill} h-4 min-w-4 px-1 text-[10px]`}>
            {count > 99 ? "99+" : count}
          </span>
        ) : null}
      </Link>
    );
  }

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={base}
    >
      {icon ? <span className="shrink-0" aria-hidden>{icon}</span> : null}
      <span className="flex-1 truncate">{label}</span>
      {count > 0 ? (
        <span role="status" aria-label={`${count} conversaciones esperan respuesta`} className={`ml-2 shrink-0 ${pill}`}>
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
