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

/**
 * Convert an INCLUSIVE local calendar-date range in `timeZone` to a HALF-OPEN UTC
 * instant range `[from, to)` — the canonical window for scheduling analytics.
 *
 * `fromYmd`/`toYmd` are "YYYY-MM-DD" local dates in the SITE's timezone. `from` is
 * local midnight of `fromYmd`; `to` is local midnight of the day AFTER `toYmd`, so
 * the whole `toYmd` day is included while its own upper midnight is EXCLUDED — this
 * matches `appointments.start_at >= from AND start_at < to`. A single day
 * (fromYmd === toYmd) yields exactly `[localMidnight, nextLocalMidnight)`.
 *
 * DST-correct via zonedPartsToUtc; calendar rollover (month/year) is done on UTC
 * date parts so "day after Jan 31" is Feb 1, etc.
 */
export function localDayRangeToUtc(
  fromYmd: string,
  toYmd: string,
  timeZone: string,
): { from: Date; to: Date } {
  const f = parseYmd(fromYmd);
  const t = parseYmd(toYmd);
  const from = zonedPartsToUtc(f.year, f.month, f.day, 0, 0, timeZone);
  // The day AFTER toYmd (calendar rollover via UTC date arithmetic on the parts).
  const next = new Date(Date.UTC(t.year, t.month - 1, t.day));
  next.setUTCDate(next.getUTCDate() + 1);
  const to = zonedPartsToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, timeZone);
  return { from, to };
}

function parseYmd(s: string): { year: number; month: number; day: number } {
  const mm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!mm) throw new Error(`Invalid YYYY-MM-DD date: ${s}`);
  return { year: Number(mm[1]), month: Number(mm[2]), day: Number(mm[3]) };
}

export const WEEKDAY_ORDER = WEEKDAYS;
