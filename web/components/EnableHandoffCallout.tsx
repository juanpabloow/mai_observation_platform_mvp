"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

/**
 * A dismissible nudge shown on a NON-handoff workflow's inbox: enabling handoff turns
 * this read-only reconstructed view into a live inbox (real messages + agent replies).
 * Dismissal is remembered per-workflow in localStorage so it doesn't nag.
 */
export function EnableHandoffCallout({
  workflowId,
  settingsHref,
}: {
  workflowId: string;
  settingsHref: string;
}) {
  const storageKey = `handoff-callout-dismissed:${workflowId}`;
  // Start hidden to avoid a flash before we can read localStorage; reveal on mount.
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(storageKey) !== "1") setVisible(true);
    } catch {
      setVisible(true);
    }
  }, [storageKey]);

  if (!visible) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
      <p className="text-sm text-emerald-800 dark:text-emerald-300">
        This is a read-only view reconstructed from executions.{" "}
        <span className="text-emerald-900 dark:text-emerald-200">Enable Human Handoff</span> to get
        live messages and reply to customers from here.
      </p>
      <div className="flex shrink-0 items-center gap-2">
        <Link
          href={settingsHref}
          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
        >
          Enable handoff
        </Link>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(storageKey, "1");
            } catch {
              /* ignore */
            }
            setVisible(false);
          }}
          className="rounded-lg px-2 py-1.5 text-sm text-emerald-800/70 transition-colors hover:text-emerald-900 dark:text-emerald-300/70 dark:hover:text-emerald-200"
          aria-label="Dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
