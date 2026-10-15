"use client";

import { useId, useRef, useState } from "react";
import type { InboxMode } from "@/lib/inboxView";
import { BTN_PRIMARY, BTN_SECONDARY, IconLock, IconSend } from "./inbox/InboxUi";

/**
 * The reply composer, IN FLOW (it does not float: the last message always stays above it).
 *
 * What it shows, in this order of precedence — the reason the operator must read first is
 * the one they cannot fix by taking the conversation:
 *   1. the WhatsApp 24 h window is closed (or never opened) → ONE line in its place, with
 *      "Plantilla no disponible": templates are not connected yet, so the button never
 *      pretends otherwise;
 *   2. the bot answers / nobody took it → one line + "Tomar conversación";
 *   3. a person answers → the field + send.
 *
 * DRAFT PER CONVERSATION: kept in sessionStorage under the client + conversation, so
 * switching conversations (or going back to the list on the phone) never loses it.
 * Enter sends and Shift+Enter breaks the line on desktop/tablet; on a touch phone Enter is
 * a line break and the button sends. The hint sits INSIDE the field, beside the send button,
 * while it is focused and empty — below it, it reserved a blank band under the composer.
 * Only when the FIELD is wide enough (container query, not the viewport): with the ficha
 * open the thread is narrow and the hint would squeeze the text to a few letters.
 */

const draftKey = (clientId: string, conversationId: string) => `inbox-draft:${clientId}:${conversationId}`;

function readDraft(key: string): string {
  try {
    return typeof window === "undefined" ? "" : (window.sessionStorage.getItem(key) ?? "");
  } catch {
    return "";
  }
}
function writeDraft(key: string, value: string): void {
  try {
    if (value) window.sessionStorage.setItem(key, value);
    else window.sessionStorage.removeItem(key);
  } catch {
    /* private mode / quota — the draft simply isn't kept */
  }
}

export function Composer({
  clientId,
  conversationId,
  mode,
  onSend,
  blockedReason = null,
  onTake,
  takeDisabledReason = null,
}: {
  clientId: string;
  conversationId: string;
  mode: InboxMode;
  onSend: (text: string) => void;
  /** The 24 h window line (closed / never opened). Null when the window is open. */
  blockedReason?: string | null;
  /** Opens the "Tomar conversación" confirmation (bot / pending). */
  onTake?: () => void;
  /** Why this login cannot take it, when it cannot. */
  takeDisabledReason?: string | null;
}) {
  const key = draftKey(clientId, conversationId);
  const [text, setText] = useState(() => readDraft(key));
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();

  if (blockedReason) {
    return (
      <div data-ib-field="" className="flex flex-col items-start gap-2.5 rounded-2xl border border-line bg-surface px-3.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
        <span className="flex min-w-0 flex-1 items-start gap-2 text-sm leading-snug text-muted">
          <span className="mt-0.5 text-faint">
            <IconLock />
          </span>
          {blockedReason}
        </span>
        <button type="button" disabled title="Las plantillas de WhatsApp aún no están conectadas" data-ib-template="" className={BTN_SECONDARY}>
          Plantilla no disponible
        </button>
      </div>
    );
  }

  if (mode !== "human") {
    return (
      <div data-ib-field="" className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-3.5 py-2.5">
        <span className="min-w-0 flex-1 text-sm leading-snug text-muted">
          {mode === "bot" ? "El bot está respondiendo. Toma la conversación para escribir." : "Nadie está respondiendo todavía. Tómala para escribir."}
        </span>
        {onTake ? (
          <button type="button" onClick={onTake} disabled={Boolean(takeDisabledReason)} title={takeDisabledReason ?? undefined} data-ib-pill="" className={BTN_PRIMARY}>
            Tomar conversación
          </button>
        ) : null}
        {takeDisabledReason ? <span className="w-full text-xs text-faint">{takeDisabledReason}</span> : null}
      </div>
    );
  }

  const update = (v: string) => {
    setText(v);
    writeDraft(key, v);
    const el = ref.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
    }
  };
  const submit = () => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    update("");
    onSend(trimmed);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // On a touch phone Enter is a line break; the button sends.
    if (window.matchMedia("(pointer: coarse) and (max-width: 767.98px)").matches) return;
    e.preventDefault();
    submit();
  };

  return (
    <div data-ib-field="" className="u-focus @container flex items-end gap-2 rounded-2xl border border-line bg-surface py-1.5 pl-3.5 pr-1.5">
      <label htmlFor={`${hintId}-field`} className="sr-only">
        Mensaje
      </label>
      <textarea
        id={`${hintId}-field`}
        ref={ref}
        value={text}
        onChange={(e) => update(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        rows={1}
        placeholder="Escribe un mensaje"
        aria-describedby={hintId}
        className="max-h-40 min-h-[2.5rem] w-full flex-1 resize-none bg-transparent py-2 text-base leading-snug outline-none placeholder:text-faint md:min-h-[2.125rem] md:py-1.5 md:text-[0.875rem]"
      />
      <span id={hintId} className={`mb-2.5 hidden shrink-0 whitespace-nowrap text-[0.6875rem] text-faint @lg:block ${focused && !text ? "" : "@lg:sr-only"}`}>
        Enter envía · Shift + Enter salto de línea
      </span>
      <button
        type="button"
        onClick={submit}
        disabled={text.trim() === ""}
        aria-label="Enviar mensaje"
        className="mb-0.5 inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-ink text-ink-fg transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:bg-chip disabled:text-faint md:size-8"
      >
        <IconSend />
      </button>
    </div>
  );
}
