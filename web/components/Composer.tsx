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
  const helper =
    blockedReason ??
    (mode === "bot"
      ? "El bot está atendiendo esta conversación. Tómala para responder."
      : mode === "pending"
        ? "Toma esta conversación para responder."
        : null);

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
    // `u-focus`: the ring goes on THIS card, not on the textarea inside it. The textarea
    // asks for `outline-none` and now actually gets it (the app-wide focus rule moved into
    // @layer base), so without this the composer would take focus with nothing to show
    // for it.
    <div className="u-focus rounded-xl border border-line bg-surface shadow-[var(--shadow-float)]">
      <textarea
        value={enabled ? text : ""}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={!enabled}
        rows={2}
        placeholder={enabled ? "Escribe una respuesta… (Enter envía, Shift+Enter salto de línea)" : (helper ?? "")}
        className="min-h-[2.75rem] w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-sm outline-none placeholder:text-faint disabled:cursor-not-allowed disabled:opacity-60"
      />
      <div className="flex items-center gap-2.5 border-t border-line-soft px-3 py-2">
        {/* TODO(inbox): "Insert slot" and "Saved reply" are in the design but have no
            backend — there is no saved-replies model, and the availability engine is
            not wired into the composer (inserting a slot would also have to book it).
            They render DISABLED and say why on hover rather than being dropped, so the
            intended shape of the toolbar survives; wire them to
            /api/scheduling/internal/availability + a canned-replies table. */}
        <ToolbarButton label="Insertar horario" title="Todavía sin conectar — necesita el motor de disponibilidad en el composer" />
        <ToolbarButton label="Respuesta guardada" title="Todavía sin conectar — no existe el modelo de respuestas guardadas" />
        {/* This one is NOT decoration: taking a conversation sets mode=human, which is
            exactly what stops the bot from answering. */}
        {enabled ? (
          <span className="hidden text-xs text-faint sm:inline">El bot queda en pausa mientras respondes</span>
        ) : blockedReason ? (
          /* SUBTLE, not an alarm: the same quiet helper slot the bot/pending states use,
             so an unavailable composer reads as a state rather than as an error. */
          <span className="min-w-0 text-xs text-faint">{blockedReason}</span>
        ) : null}
        <button
          type="button"
          disabled={!enabled || text.trim() === ""}
          onClick={submit}
          className="ml-auto inline-flex h-8 items-center rounded-md bg-ink px-4 text-xs font-semibold text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          Enviar
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
