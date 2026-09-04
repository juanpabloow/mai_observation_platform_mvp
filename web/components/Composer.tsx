"use client";

import { useState } from "react";
import type { InboxMode } from "@/lib/inboxView";

/**
 * The reply composer (H-3 activation).
 *   - bot     → disabled input, "El bot está atendiendo esta conversación…"
 *   - pending → disabled input, "Toma esta conversación para responder."
 *   - human   → input + Send ENABLED for anyone with client access,
 *               UNLESS `blockedReason` says the provider will not accept it.
 *
 * Enter sends, Shift+Enter inserts a newline. Sending is OPTIMISTIC and fire-and-
 * forget: on submit the input clears immediately (the parent renders the sending
 * bubble), so the agent can compose the next message right away — the input is not
 * blocked while a prior send is in flight.
 */
export function Composer({
  mode,
  onSend,
  blockedReason = null,
}: {
  mode: InboxMode;
  onSend: (text: string) => void;
  /**
   * A provider-side rule that makes replying impossible right now — today only
   * WhatsApp's 24-hour service window (see serviceWindow). Null when sending is fine.
   *
   * It is checked ALONGSIDE `mode`, not instead of it: a conversation can be both
   * bot-handled and outside the window, and the reason the agent needs to read first is
   * the one they cannot fix by taking the conversation.
   */
  blockedReason?: string | null;
}) {
  const [text, setText] = useState("");
  const enabled = mode === "human" && blockedReason === null;
  // The placeholder reflects the MODE when the agent can't type; the 24h-window reason
  // shows in the amber banner above, never doubled into the field.
  const placeholder =
    mode === "bot"
      ? "El bot está atendiendo esta conversación. Tómala para responder."
      : mode === "pending"
        ? "Toma esta conversación para responder."
        : "Escribe un mensaje…";

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
    <div className="flex flex-col gap-2">
      {/* THE 24h WINDOW notice (design image): an amber strip above the field. WhatsApp
          only accepts free-form replies inside 24h of the customer's last message; outside
          it, only an approved template can be sent. */}
      {blockedReason ? (
        <div className="flex items-center gap-2.5 rounded-lg border border-warn/30 bg-warn-soft px-3 py-2.5">
          <svg aria-hidden viewBox="0 0 16 16" fill="none" className="size-4 shrink-0 text-warn">
            <circle cx="8" cy="8" r="6.4" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8 5v3.4M8 10.8h.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug text-warn">{blockedReason}</span>
          <button
            type="button"
            disabled
            title="Las plantillas de WhatsApp aún no están conectadas"
            className="shrink-0 text-[0.8125rem] font-semibold text-warn transition-opacity hover:opacity-80 disabled:cursor-not-allowed"
          >
            Enviar plantilla
          </button>
        </div>
      ) : null}
      {/* The field + Enviar on one clean row (design image). `u-focus` puts the ring on the
          card, not the textarea (which is outline-none). */}
      <div className="u-focus flex items-end gap-2 rounded-xl border border-line bg-surface px-2.5 py-2 shadow-[var(--shadow-float)]">
        <textarea
          value={enabled ? text : ""}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!enabled}
          rows={1}
          placeholder={placeholder}
          className="min-h-[2.25rem] w-full flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button
          type="button"
          disabled={!enabled || text.trim() === ""}
          onClick={submit}
          className="mb-0.5 inline-flex h-9 shrink-0 items-center rounded-lg bg-ink px-4 text-sm font-medium text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enviar
        </button>
      </div>
    </div>
  );
}
