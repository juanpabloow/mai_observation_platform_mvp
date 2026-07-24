"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";

const POLL_MS = 5000;

/**
 * A sidebar nav item with a live pending-count badge (the client-level aggregated
 * pending count). Polls on mount and every ~5s, paused while the tab is hidden.
 *
 * Renders to match the sidebar's other nav items and supports the rail's two states:
 *   - expanded: icon + label, count badge on the right;
 *   - collapsed (`collapsed`): icon only, centered, with an accessible tooltip
 *     (`title` + `aria-label` that includes the pending count) and a small dot when
 *     there are pending conversations.
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

  const base = `group relative flex items-center rounded-lg text-sm transition-colors ${
    collapsed ? "justify-center px-0 py-2" : "gap-2.5 px-3 py-2"
  } ${active ? "bg-subtle font-medium text-foreground" : "text-muted hover:bg-subtle hover:text-foreground"}`;

  // Collapsed: icon only, tooltip + count folded into the accessible name; a small dot
  // signals pending without a number (there's no room for the badge).
  if (collapsed) {
    return (
      <Link
        href={href}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        aria-label={count > 0 ? `${label}, ${count} pending` : label}
        title={count > 0 ? `${label} · ${count} pending` : label}
        className={base}
      >
        {icon ? <span className="shrink-0" aria-hidden>{icon}</span> : <span>{label}</span>}
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute right-1.5 top-1.5 size-2 rounded-full bg-amber-500 dark:bg-amber-400"
          />
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
        <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
