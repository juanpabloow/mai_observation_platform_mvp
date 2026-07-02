"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Auto-refresh trigger + a subtle COUNTDOWN indicator for the executions list.
 * Every second (while enabled and the tab is visible) it ticks down; at zero it
 * calls router.refresh() — Next's soft refresh, which re-runs the server component
 * with the CURRENT URL params and swaps in fresh rows without a full reload,
 * scroll reset, or losing UI state (so the detail panel isn't disturbed).
 *
 * Indicator: "Refreshes in Ns", resetting on each refresh — no persistent "on"
 * badge. When the tab is hidden the timer PAUSES (no ticking, no refresh), so the
 * countdown freezes rather than counting into a backgrounded tab; becoming visible
 * refreshes immediately and resets. Clicking toggles auto-refresh off (a minimal
 * "Auto-refresh off" you can click to resume).
 */
export function AutoRefresh({ intervalSeconds = 30 }: { intervalSeconds?: number }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(true);
  const [secondsLeft, setSecondsLeft] = useState(intervalSeconds);

  useEffect(() => {
    if (!enabled) return;
    setSecondsLeft(intervalSeconds);
    let elapsed = 0;

    const refresh = () => {
      router.refresh();
      elapsed = 0;
      setSecondsLeft(intervalSeconds);
    };

    // One 1s timer drives both the countdown and the refresh. While hidden it does
    // nothing (elapsed frozen → countdown pauses).
    const ticker = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      elapsed += 1;
      if (elapsed >= intervalSeconds) {
        refresh();
      } else {
        setSecondsLeft(intervalSeconds - elapsed);
      }
    }, 1000);

    // Returning to the tab refreshes immediately, then resumes the countdown.
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      clearInterval(ticker);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, intervalSeconds, router]);

  if (!enabled) {
    return (
      <button
        type="button"
        onClick={() => setEnabled(true)}
        title="Auto-refresh is off — click to resume"
        className="inline-flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-foreground"
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-neutral-500" />
        Auto-refresh off
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEnabled(false)}
      title="Click to pause auto-refresh"
      className="inline-flex items-center gap-1.5 text-xs text-neutral-500 transition-colors hover:text-foreground"
    >
      <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-green-400" />
      Refreshes in {secondsLeft}s
    </button>
  );
}
