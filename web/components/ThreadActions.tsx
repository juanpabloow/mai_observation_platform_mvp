"use client";

import { useTransition } from "react";
import {
  dismissConversationAction,
  returnConversationToBotAction,
  takeConversationAction,
  type InboxActionResult,
} from "@/lib/inboxActions";
import type { InboxHeaderView } from "@/lib/inboxView";

/**
 * The conversation MODE control — a `Humano | Bot` segmented toggle (design image 20).
 * Clicking the inactive segment performs the real handoff action (the SERVER actions
 * re-check permissions; this only decides what to show / enable):
 *   - Humano ← takeConversationAction         (bot | pending → human)
 *   - Bot    ← returnConversationToBotAction   (human → bot; assigned agent or owner/admin)
 *              or dismissConversationAction     (pending → bot, i.e. "descartar")
 * When the conversation is `pending`, neither segment is filled: a human has been requested
 * but nobody has taken it yet — clicking Humano takes it, clicking Bot dismisses it.
 */
export function ThreadActions({
  clientId,
  header,
  viewerUserId,
  viewerIsFullAccess,
  onResult,
}: {
  clientId: string;
  header: InboxHeaderView;
  viewerUserId: string;
  viewerIsFullAccess: boolean;
  onResult: (r: InboxActionResult) => void;
}) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<InboxActionResult>) =>
    startTransition(async () => {
      onResult(await fn());
    });

  const mode = header.mode;
  const isHuman = mode === "human";
  const isBot = mode === "bot";
  // Handing a live conversation back to the bot is restricted to the agent on it (or an
  // owner/admin); taking it (Humano) and dismissing a pending escalation are open to anyone
  // with client access, matching the server actions.
  const canReturn = isHuman && (viewerIsFullAccess || header.assignedAgentUserId === viewerUserId);

  const take = () => run(() => takeConversationAction(clientId, header.id));
  const toBot = () =>
    run(() => (mode === "pending" ? dismissConversationAction : returnConversationToBotAction)(clientId, header.id));

  const seg =
    "inline-flex h-7 items-center rounded-md px-3 text-[0.78125rem] font-medium transition-colors disabled:cursor-not-allowed";
  const on = "bg-surface text-foreground shadow-[var(--shadow-card)]";
  const off = "text-muted enabled:hover:text-foreground disabled:opacity-50";

  return (
    <div
      role="group"
      aria-label="Modo de la conversación"
      className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line-strong bg-chip p-0.5"
    >
      <button
        type="button"
        onClick={take}
        disabled={pending || isHuman}
        aria-pressed={isHuman}
        title="Un humano responde esta conversación"
        className={`${seg} ${isHuman ? on : off}`}
      >
        Humano
      </button>
      <button
        type="button"
        onClick={toBot}
        disabled={pending || isBot || (isHuman && !canReturn)}
        aria-pressed={isBot}
        title={isHuman && !canReturn ? "Solo el agente asignado o un administrador puede devolverla al bot" : "El bot responde esta conversación"}
        className={`${seg} ${isBot ? on : off}`}
      >
        Bot
      </button>
    </div>
  );
}
