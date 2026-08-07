import type { InboxMode } from "@/lib/inboxView";

/**
 * The conversation-mode badge (bot / pending / human) — a compact UPPERCASE mono
 * chip, the same shape the rest of the operative surfaces use for state.
 * Presentational only (no client/server coupling), reused by the inbox list and
 * thread header.
 *   bot     → neutral chip (automated, quiet)
 *   pending → warn        (needs attention)
 *   human   → SOLID brand (a person owns this conversation — the loudest state,
 *             and the one the redesign puts beside the customer's name)
 * All three run on theme tokens, so they invert with the app instead of pinning a
 * raw palette colour that only works in light mode.
 */
const MODE_STYLES: Record<InboxMode, { label: string; classes: string }> = {
  bot: { label: "Bot", classes: "bg-chip text-muted" },
  pending: { label: "Pending", classes: "bg-warn-soft text-warn" },
  human: { label: "Human", classes: "bg-brand text-white" },
};

export function ModeBadge({ mode, className = "" }: { mode: InboxMode; className?: string }) {
  const style = MODE_STYLES[mode];
  return (
    <span
      className={`u-mono inline-flex items-center rounded px-1.5 py-0.5 text-[0.625rem] font-semibold uppercase tracking-wider ${style.classes} ${className}`}
    >
      {style.label}
    </span>
  );
}
