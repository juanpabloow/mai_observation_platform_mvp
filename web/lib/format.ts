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

/** Tailwind classes for a status badge (green success / red error / neutral). */
export function statusBadgeClasses(status: string): string {
  const base =
    "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
  switch (status) {
    case "success":
      return `${base} bg-green-500/15 text-green-400 ring-green-500/30`;
    case "error":
    case "crashed":
      return `${base} bg-red-500/15 text-red-400 ring-red-500/30`;
    default:
      return `${base} bg-white/10 text-neutral-300 ring-white/15`;
  }
}
