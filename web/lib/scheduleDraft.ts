import { addDays, expandSeries, localToday, type ScheduleSeries } from "@worker/scheduling/series.js";

/**
 * Unsaved schedule DRAFTS as availability "holds" — the times a break/block being edited
 * would take, so rescheduling one of its affected appointments never lands inside it.
 * Pure (the series engine is client-safe); holds can only REMOVE times the server offers.
 * Format: `<staff_id|site>~<from ISO>~<until ISO>` (internal availability route).
 */
export function draftHolds(input: {
  staffId: string | null;
  timeZone: string;
  weekdays: number[];
  startMin: number;
  endMin: number;
  /** First local date of the draft (the cut, or the single date). */
  startsOn: string;
  endsOn: string | null;
  /** How far ahead to hold (days). */
  days?: number;
  now?: Date;
}): string[] {
  const today = localToday(input.now ?? new Date(), input.timeZone);
  const from = input.startsOn > today ? input.startsOn : today;
  const horizon = addDays(today, input.days ?? 62);
  const to = input.endsOn && input.endsOn < horizon ? input.endsOn : horizon;
  if (to < from) return [];
  const s: ScheduleSeries = {
    id: "draft",
    site_id: "draft",
    staff_id: input.staffId,
    kind: "block",
    weekdays: input.weekdays,
    start_min: input.startMin,
    end_min: input.endMin,
    starts_on: input.startsOn,
    ends_on: input.endsOn,
    reason: null,
    public_reason: null,
  };
  const who = input.staffId ?? "site";
  return expandSeries([s], [], from, to, input.timeZone)
    .slice(0, 120)
    .map((o) => `${who}~${o.from.toISOString()}~${o.until.toISOString()}`);
}

/** A dated block draft (one range). */
export function rangeHold(staffId: string | null, from: Date, until: Date): string[] {
  const out: string[] = [];
  // The route caps each hold at 24h: split long ranges by day.
  let a = from.getTime();
  const b = until.getTime();
  while (a < b && out.length < 120) {
    const end = Math.min(b, a + 86_400_000);
    out.push(`${staffId ?? "site"}~${new Date(a).toISOString()}~${new Date(end).toISOString()}`);
    a = end;
  }
  return out;
}
