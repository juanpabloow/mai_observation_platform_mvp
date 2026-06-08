"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Auto-refresh TRIGGER for the executions list. Its only job is: every
 * `intervalSeconds`, if the tab is visible and the toggle is on, call
 * router.refresh() — Next's soft refresh, which re-runs the server component
 * with the CURRENT URL params (same filters/sort/page) and swaps in fresh rows
 * without a full reload, scroll reset, or losing UI state.
 *
 * Deliberately separate from the data fetching (the existing server-side query).
 * A future realtime mechanism (SSE/websocket) can replace this timer without
 * touching the query/tenant-scoping logic.
 */
export function AutoRefresh({ intervalSeconds = 30 }: { intervalSeconds?: number }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const lastRefreshRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;

    // Reset the "updated Ns ago" clock whenever we (re)enable.
    lastRefreshRef.current = Date.now();
    setSecondsAgo(0);

    const refresh = () => {
      router.refresh();
      lastRefreshRef.current = Date.now();
      setSecondsAgo(0);
    };

    const intervalMs = intervalSeconds * 1000;
    const refreshTimer = setInterval(() => {
      // Pause while the tab is hidden — no point polling a backgrounded tab.
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, intervalMs);

    // Tick the "updated Ns ago" label once a second.
    const labelTimer = setInterval(() => {
      setSecondsAgo(Math.round((Date.now() - lastRefreshRef.current) / 1000));
    }, 1000);

    // When the tab becomes visible again, refresh immediately, then resume.
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(refreshTimer);
      clearInterval(labelTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalSeconds, router]);

  return (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      <button
        type="button"
        onClick={() => setEnabled((e) => !e)}
        aria-pressed={enabled}
        title={enabled ? "Auto-refresh is on — click to pause" : "Auto-refresh is off — click to resume"}
        className="inline-flex items-center gap-1.5 rounded-full border border-black/10 px-2.5 py-1 transition-colors hover:bg-black/[0.04] dark:border-white/15 dark:hover:bg-white/[0.06]"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            enabled ? "animate-pulse bg-green-400" : "bg-neutral-600"
          }`}
        />
        <span>Auto-refresh {enabled ? "on" : "off"}</span>
      </button>
      {enabled ? <span>· updated {secondsAgo}s ago</span> : null}
    </div>
  );
}
