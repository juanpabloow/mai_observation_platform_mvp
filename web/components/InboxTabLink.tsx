"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const POLL_MS = 5000;

/**
 * The sidebar Inbox tab. Shows a pending-count badge that stays live from ANY tab of
 * the client: seeded server-side (initialCount) for an instant, correct value, then
 * light-polled from the session-authed count route (paused while the tab is hidden).
 */
export function InboxTabLink({
  clientId,
  href,
  active,
  initialCount,
  label = "Inbox",
}: {
  clientId: string;
  href: string;
  active: boolean;
  initialCount: number;
  label?: string;
}) {
  const [count, setCount] = useState(initialCount);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/inbox/${clientId}/pending-count`, { cache: "no-store" });
      if (!res.ok) return;
      const payload: { pendingCount?: number } = await res.json();
      if (typeof payload.pendingCount === "number") setCount(payload.pendingCount);
    } catch {
      /* keep last-known count */
    }
  }, [clientId]);

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
      void load();
      start();
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-subtle font-medium text-foreground"
          : "text-muted hover:bg-subtle hover:text-foreground"
      }`}
    >
      <span>{label}</span>
      {count > 0 ? (
        <span className="ml-2 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-amber-700 dark:text-amber-400">
          {count}
        </span>
      ) : null}
    </Link>
  );
}
