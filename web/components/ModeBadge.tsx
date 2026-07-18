import type { InboxMode } from "@/lib/inboxView";

/**
 * The conversation-mode badge (bot / pending / human) — distinct colors in both
 * themes. Presentational only (no client/server coupling), reused by the inbox list
 * and thread header.
 *   bot     → neutral (automated, quiet)
 *   pending → amber   (needs attention)
 *   human   → emerald (a live agent has it)
 */
const MODE_STYLES: Record<InboxMode, { label: string; classes: string }> = {
  bot: {
    label: "Bot",
    classes:
      "bg-neutral-500/12 text-neutral-600 ring-neutral-500/25 dark:text-neutral-300 dark:ring-neutral-400/25",
  },
  pending: {
    label: "Pending",
    classes: "bg-amber-500/15 text-amber-700 ring-amber-600/30 dark:text-amber-400 dark:ring-amber-500/30",
  },
  human: {
    label: "Human",
    classes:
      "bg-emerald-500/15 text-emerald-700 ring-emerald-600/30 dark:text-emerald-400 dark:ring-emerald-500/30",
  },
};

export function ModeBadge({ mode, className = "" }: { mode: InboxMode; className?: string }) {
  const style = MODE_STYLES[mode];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${style.classes} ${className}`}
    >
      {style.label}
    </span>
  );
}
