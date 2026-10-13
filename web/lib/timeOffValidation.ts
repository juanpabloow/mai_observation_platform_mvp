/**
 * Pure validation + shaping for a Time Off block, BEFORE timezone conversion. It turns the
 * two entry modes into a single pair of LOCAL wall-clock strings ("YYYY-MM-DDTHH:MM") that
 * the action anchors to the site timezone via localWallClockToUtc (the one tz system).
 *
 *   - full_day: a date RANGE (vacations, a day off). A single day off = start===end. The
 *     block covers whole local days: [startDate 00:00, endDate+1 00:00).
 *   - partial:  ONE date + from–to times ("out 14:00–16:00 on the 22nd"). Must fit within
 *     that one local day (end after start, same date).
 *
 * No tz math here (that needs the site tz) — this only validates the shape and computes the
 * local wall-clock bounds, so it is unit-testable on its own.
 */

export const TIMEOFF_REASON_MAX = 200;

export type TimeOffInput =
  | { mode: "full_day"; startDate: string; endDate: string }
  | { mode: "partial"; date: string; startTime: string; endTime: string };

export type TimeOffShape =
  | { ok: true; startLocal: string; endLocal: string }
  | { ok: false; error: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** The calendar day AFTER `date` (YYYY-MM-DD), wall-clock — so a full-day block's end is the
 *  exclusive midnight after the last day. Pure date arithmetic, timezone-independent. */
function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function normalizeTimeOff(input: TimeOffInput): TimeOffShape {
  if (input.mode === "full_day") {
    if (!isValidDate(input.startDate)) return { ok: false, error: "startDate: a valid date is required." };
    if (!isValidDate(input.endDate)) return { ok: false, error: "endDate: a valid date is required." };
    if (input.endDate < input.startDate) return { ok: false, error: "endDate: must be on or after the start date." };
    return { ok: true, startLocal: `${input.startDate}T00:00`, endLocal: `${nextDay(input.endDate)}T00:00` };
  }
  // partial
  if (!isValidDate(input.date)) return { ok: false, error: "date: a valid date is required." };
  if (!TIME_RE.test(input.startTime)) return { ok: false, error: "startTime: a valid time (HH:MM) is required." };
  if (!TIME_RE.test(input.endTime)) return { ok: false, error: "endTime: a valid time (HH:MM) is required." };
  if (input.endTime <= input.startTime) return { ok: false, error: "endTime: must be after the start time (within one day)." };
  return { ok: true, startLocal: `${input.date}T${input.startTime}`, endLocal: `${input.date}T${input.endTime}` };
}

/** Optional internal label: trimmed, blank→null, capped. NEVER exposed by the machine API. */
export function normalizeReason(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  if (t === "") return null;
  return t.slice(0, TIMEOFF_REASON_MAX);
}
