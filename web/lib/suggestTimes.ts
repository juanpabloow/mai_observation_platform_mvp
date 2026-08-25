/**
 * Alternative-time suggestion strategy for the "that time isn't available" messages. PURE
 * (no server, no DB) so both the suggestion path and its tests agree on exactly how a small
 * set of times is chosen — the bug this replaced returned the first six CONSECUTIVE 15-minute
 * steps at the start of the day (09:00, 09:15, … — the same time to a customer, and nowhere
 * near what was asked for).
 */

/** At most this many suggestions, spread at least this far apart. */
export const MAX_SUGGESTIONS = 5;
export const SUGGESTION_SPREAD_MS = 30 * 60 * 1000;

/**
 * Pick a small, SPREAD set of starts — NEAREST to `around` first (the time the customer
 * actually asked about), then returned in chronological order for display. Greedy: take the
 * closest slot, then the next-closest that is ≥ `gapMs` from every one already taken. The
 * result straddles the requested time on BOTH sides and never truncates to the first few
 * consecutive steps of the day.
 */
export function spreadNearest(
  starts: Date[],
  around: Date,
  max: number = MAX_SUGGESTIONS,
  gapMs: number = SUGGESTION_SPREAD_MS,
): Date[] {
  const byNearest = [...starts].sort(
    (a, b) => Math.abs(a.getTime() - around.getTime()) - Math.abs(b.getTime() - around.getTime()),
  );
  const picked: Date[] = [];
  for (const d of byNearest) {
    if (picked.length >= max) break;
    if (picked.every((p) => Math.abs(p.getTime() - d.getTime()) >= gapMs)) picked.push(d);
  }
  return picked.sort((a, b) => a.getTime() - b.getTime());
}
