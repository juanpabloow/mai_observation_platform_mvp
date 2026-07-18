"use client";

import { useState } from "react";
import type { InboxMode } from "@/lib/inboxView";

/**
 * Composer SHELL only (H-2). No send path is wired — that arrives in H-3.
 *   - bot     → disabled input, "The bot is handling this conversation. Take it to reply."
 *   - pending → disabled input, "Take this conversation to reply."
 *   - human   → input ENABLED for anyone with access (teammates may draft), but the
 *               Send button is disabled with a tooltip.
 */
export function Composer({ mode }: { mode: InboxMode }) {
  const [text, setText] = useState("");
  const enabled = mode === "human";
  const helper =
    mode === "bot"
      ? "The bot is handling this conversation. Take it to reply."
      : mode === "pending"
        ? "Take this conversation to reply."
        : null;

  return (
    <div className="border-t border-line pt-3">
      <div className="flex items-end gap-2">
        <textarea
          value={enabled ? text : ""}
          onChange={(e) => setText(e.target.value)}
          disabled={!enabled}
          rows={2}
          placeholder={enabled ? "Type a reply…" : (helper ?? "")}
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-line-strong disabled:cursor-not-allowed disabled:bg-black/[0.02] disabled:opacity-60 dark:disabled:bg-card"
        />
        <button
          type="button"
          disabled
          title="Sending arrives with the send pipeline (next phase)."
          className="cursor-not-allowed rounded-lg bg-emerald-600/60 px-4 py-2 text-sm font-medium text-white opacity-60"
        >
          Send
        </button>
      </div>
      <p className="mt-1 text-xs text-faint">
        {enabled
          ? "Sending arrives with the send pipeline (next phase)."
          : helper}
      </p>
    </div>
  );
}
