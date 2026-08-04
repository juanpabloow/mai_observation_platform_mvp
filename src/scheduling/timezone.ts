/**
 * IANA-timezone helpers built on the platform Intl API — NO new dependency.
 *
 * Every instant is a UTC `Date`; a site's local wall-clock hours (opening/working
 * hours) are interpreted in the site's IANA timezone (e.g. America/Bogota). These
 * helpers convert between "local wall-clock parts in a tz" and UTC instants,
 * correctly accounting for the tz's offset (including DST for zones that observe
 * it — Bogota does not, but the math is general).
 */

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The tz offset (ms east of UTC) in effect at `date` for `timeZone`. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // The wall-clock the tz shows for this instant, read back as if it were UTC.
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - date.getTime();
}

/**
 * Convert local wall-clock parts in `timeZone` to the corresponding UTC instant.
 * Two-pass to be correct across DST transitions (the offset can differ between the
 * naive guess and the true instant).
 */
export function zonedPartsToUtc(
  year: number,
  month1: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month1 - 1, day, hour, minute, 0);
  let offset = tzOffsetMs(new Date(naive), timeZone);
  let utc = naive - offset;
  // Re-evaluate the offset at the computed instant; correct once if it changed.
  const offset2 = tzOffsetMs(new Date(utc), timeZone);
  if (offset2 !== offset) {
    offset = offset2;
    utc = naive - offset;
  }
  return new Date(utc);
}

/** The local calendar parts (+ weekday) of `date` in `timeZone`. */
export function utcToZonedParts(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: Weekday } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const wk = get('weekday').toLowerCase().slice(0, 3) as Weekday;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    weekday: wk,
  };
}

/**
 * Parse a local wall-clock string "YYYY-MM-DDTHH:MM" (the value an <input
 * type="datetime-local"> yields) and interpret it in `timeZone` → the UTC instant.
 * This is how schedule-exception times entered in the admin UI are anchored to the
 * SITE's timezone (never the browser's). Throws on malformed input.
 */
export function localWallClockToUtc(isoLocal: string, timeZone: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(isoLocal);
  if (!m) throw new Error(`Invalid local datetime: ${isoLocal}`);
  return zonedPartsToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), timeZone);
}

/** "HH:MM" → minutes since local midnight. Throws on malformed input. */
export function parseHhMm(hhmm: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) throw new Error(`Invalid HH:MM time: ${hhmm}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) {
    throw new Error(`Out-of-range HH:MM time: ${hhmm}`);
  }
  return h * 60 + min;
}

/**
 * Parse a human clock time to canonical "HH:MM" (24h), or null if unparseable. The value
 * an LLM emits is far more robust than a 24-char ISO string, and the server owns the
 * timezone. ACCEPTED (case-insensitive, surrounding space tolerated):
 *   - 24-hour:  "H:MM" or "HH:MM"        e.g. "9:00", "14:30", "09:05"  (00:00–23:59)
 *   - 12-hour:  "H[:MM] am|pm"           e.g. "9 am", "9:00am", "5 pm", "5:30 p.m.", "12 am"
 *               ("am"/"a.m."/"pm"/"p.m." all accepted; 12 am → 00:00, 12 pm → 12:00)
 * A bare number ("5") is rejected as ambiguous — require a colon (24h) or am/pm (12h).
 */
export function parseClockTime(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  // 12-hour with meridiem.
  let m = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?$/.exec(s);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    if (m[3] === 'a') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
    return `${pad(h)}:${pad(min)}`;
  }
  // 24-hour with a colon.
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return `${pad(h)}:${pad(min)}`;
  }
  return null;
}

/**
 * Combine a local `day` ("YYYY-MM-DD") + `time` (any form parseClockTime accepts) into the
 * exact UTC instant, interpreted in `timeZone`. Returns null for a malformed/impossible
 * date or unparseable time. This is what removes timezone conversion from the caller: it is
 * DST-correct (zonedPartsToUtc re-evaluates the offset at the instant), so the same day+time
 * yields the right instant in a DST zone as well as a fixed-offset one.
 */
export function combineLocalDayTime(day: string, time: string, timeZone: string): Date | null {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? '').trim());
  if (!dm) return null;
  const hhmm = parseClockTime(time);
  if (!hhmm) return null;
  const [y, mo, d] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = hhmm.split(':').map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const instant = zonedPartsToUtc(y, mo, d, h, mi, timeZone);
  // Reject impossible calendar dates (e.g. 2026-02-30 rolls over): the local DATE must
  // round-trip. (Time is not re-checked, so a DST spring-forward gap simply finds no slot.)
  const p = utcToZonedParts(instant, timeZone);
  if (p.year !== y || p.month !== mo || p.day !== d) return null;
  return instant;
}

/**
 * The list of local calendar dates (as {year,month,day}) that the UTC range
 * [from, to] touches, in `timeZone`. Inclusive of both endpoints' local dates.
 */
export function localDatesInRange(
  from: Date,
  to: Date,
  timeZone: string,
): Array<{ year: number; month: number; day: number }> {
  const out: Array<{ year: number; month: number; day: number }> = [];
  const startParts = utcToZonedParts(from, timeZone);
  // Walk one local day at a time from the start local date until we pass `to`.
  let cursor = zonedPartsToUtc(startParts.year, startParts.month, startParts.day, 0, 0, timeZone);
  const guard = 400; // hard cap (booking horizon is bounded well below a year)
  for (let i = 0; i < guard; i++) {
    const p = utcToZonedParts(cursor, timeZone);
    // Local midnight of this day.
    const dayStart = zonedPartsToUtc(p.year, p.month, p.day, 0, 0, timeZone);
    if (dayStart.getTime() > to.getTime()) break;
    out.push({ year: p.year, month: p.month, day: p.day });
    // Advance ~26h then snap to local midnight to robustly cross DST days.
    cursor = new Date(dayStart.getTime() + 26 * 60 * 60 * 1000);
  }
  return out;
}

export const WEEKDAY_ORDER = WEEKDAYS;
