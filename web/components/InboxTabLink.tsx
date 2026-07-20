"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

const POLL_MS = 5000;

/**
 * A sidebar nav item with a live pending-count badge. H-7: the badge is now scoped per
 * WORKFLOW (countEndpoint points at the workflow's pending-count route) — the old
 * client-level attention badge was removed with the attention surface. Polls on mount
 * and every ~5s, paused while the tab is hidden.
 */
export function InboxTabLink({
  href,
  active,
  countEndpoint,
  label = "Inbox",
}: {
  href: string;
  active: boolean;
  countEndpoint: string;
  label?: string;
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
