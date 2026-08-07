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
    // ONE bordered card holds the field and its toolbar, as in the design — the
    // reply area reads as a single object docked to the thread, not an input with
    // loose buttons under it.
    <div className="rounded-bubble border border-line-strong bg-surface">
      <textarea
        value={enabled ? text : ""}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={!enabled}
        rows={2}
        placeholder={enabled ? "Type a reply… (Enter to send, Shift+Enter for a newline)" : (helper ?? "")}
        className="min-h-[2.75rem] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-sm outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex items-center gap-2 px-2 pb-2">
        {/* TODO(inbox): "Insert slot" and "Saved reply" are in the design but have no
            backend — there is no saved-replies model, and the availability engine is
            not wired into the composer (inserting a slot would also have to book it).
            They render DISABLED and say why on hover rather than being dropped, so the
            intended shape of the toolbar survives; wire them to
            /api/scheduling/internal/availability + a canned-replies table. */}
        <ToolbarButton label="Insert slot" title="Not wired yet — needs the availability engine in the composer" />
        <ToolbarButton label="Saved reply" title="Not wired yet — there is no saved-replies model" />
        {/* This one is NOT decoration: taking a conversation sets mode=human, which is
            exactly what stops the bot from answering. */}
        {enabled ? <span className="hidden text-xs text-faint sm:inline">Bot stays paused while you reply</span> : null}
        <button
          type="button"
          disabled={!enabled || text.trim() === ""}
          onClick={submit}
          className="ml-auto inline-flex h-8 items-center rounded-md bg-brand px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}

/** A composer affordance that exists in the design but has nothing behind it yet. */
function ToolbarButton({ label, title }: { label: string; title: string }) {
  return (
    <button
      type="button"
      disabled
      title={title}
      className="inline-flex h-8 cursor-not-allowed items-center rounded-md border border-line px-2.5 text-xs text-faint"
    >
      {label}
    </button>
  );
}
