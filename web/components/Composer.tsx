"use client";

import { useState } from "react";
import type { InboxMode } from "@/lib/inboxView";

/**
 * The reply composer (H-3 activation).
 *   - bot     → disabled input, "The bot is handling this conversation. Take it to reply."
 *   - pending → disabled input, "Take this conversation to reply."
 *   - human   → input + Send ENABLED for anyone with client access.
 *
 * Enter sends, Shift+Enter inserts a newline. Sending is OPTIMISTIC and fire-and-
 * forget: on submit the input clears immediately (the parent renders the sending
 * bubble), so the agent can compose the next message right away — the input is not
 * blocked while a prior send is in flight.
 */
export function Composer({ mode, onSend }: { mode: InboxMode; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const enabled = mode === "human";
  const helper =
    mode === "bot"
      ? "The bot is handling this conversation. Take it to reply."
      : mode === "pending"
        ? "Take this conversation to reply."
        : null;

  const submit = () => {
    const trimmed = text.trim();
    if (!enabled || trimmed === "") return;
    setText(""); // clear immediately so the next message can be composed
    onSend(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-line pt-3">
      <div className="flex items-end gap-2">
        <textarea
          value={enabled ? text : ""}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!enabled}
          rows={2}
          placeholder={enabled ? "Type a reply… (Enter to send, Shift+Enter for a newline)" : (helper ?? "")}
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-line bg-transparent px-3 py-2 text-sm outline-none focus:border-line-strong disabled:cursor-not-allowed disabled:bg-black/[0.02] disabled:opacity-60 dark:disabled:bg-card"
        />
        <button
          type="button"
          disabled={!enabled || text.trim() === ""}
          onClick={submit}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {/* H-8: no caption — the disabled-mode helper lives in the placeholder only. */}
    </div>
  );
}
