/** Shared, framework-agnostic display formatters (safe in server or client). */

export function formatDateTime(date: Date): string {
  return date.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Format a millisecond duration as "850ms" / "1.2s" / "1.5m", or "—" if null. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${(seconds / 60).toFixed(1)}m`;
}

/** Stable calendar-day key (local time), for grouping turns by day. */
export function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

/** A message time, e.g. "2:34 PM". */
export function formatChatTime(date: Date): string {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** A chat date divider: "Today" / "Yesterday" / "June 5, 2026". */
export function formatDayLabel(date: Date, now: Date): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/**
 * Conversation-list timestamp (WhatsApp style): today → "2:34 PM", yesterday →
 * "Yesterday", within a week → weekday, else → "Jun 5" (+ year if not this year).
 */
export function formatListTimestamp(date: Date, now: Date): string {
  const key = localDayKey(date);
  if (key === localDayKey(now)) return formatChatTime(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDayKey(yesterday)) return "Yesterday";
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 6);
  if (date >= weekAgo) return date.toLocaleDateString("en-US", { weekday: "long" });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(
    "en-US",
    sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" },
  );
}

/** Tailwind classes for a status badge (green success / red error / neutral). */
export function statusBadgeClasses(status: string): string {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
  switch (status) {
    case "success":
      return `${base} bg-green-500/15 text-green-700 ring-green-600/30 dark:text-green-400 dark:ring-green-500/30`;
    case "error":
    case "crashed":
      return `${base} bg-red-500/15 text-red-700 ring-red-600/30 dark:text-red-400 dark:ring-red-500/30`;
    default:
      return `${base} bg-subtle text-muted ring-line`;
  }
}
