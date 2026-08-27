import type { InboxMode } from "@/lib/inboxView";

/**
 * The conversation-mode badge (bot / pending / human) — who is answering right now.
 *
 * Restyled to the design (docs/ui-redesign-crm-inbox.md §3.2): a NEUTRAL chip carrying a
 * coloured DOT, not a filled pill. The three states used to be three fills, of which
 * `human` was a solid brand red — the loudest object in the thread header, sitting right
 * beside the customer's name and competing with the one action that matters there
 * (`Devolver al bot`).
 *
 * Moving the colour into a 6px dot keeps the state instantly readable while letting the
 * name be the headline. The chip is never colour-alone: every state prints its own word,
 * so it survives greyscale and a colour-blind reader.
 *
 * Presentational only (no client/server coupling), reused by the inbox list and the
 * thread header. All three run on theme tokens, so they invert with the app instead of
 * pinning a raw palette colour that only works in light mode.
 */
const MODE_STYLES: Record<InboxMode, { label: string; dot: string }> = {
  // The bot answering is the resting state — a neutral dot, deliberately not a hue.
  bot: { label: "Bot", dot: "bg-faint" },
  // Waiting for a person: the amber "needs attention", the same one the queue lane uses.
  pending: { label: "Pendiente", dot: "bg-warn" },
  // A person owns this conversation. THE red — one of the three things red is for.
  human: { label: "Humano", dot: "bg-brand" },
};

export function ModeBadge({ mode, className = "" }: { mode: InboxMode; className?: string }) {
  const style = MODE_STYLES[mode];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm bg-chip px-2 py-1 text-[0.6875rem] font-semibold text-muted ${className}`}
    >
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}
