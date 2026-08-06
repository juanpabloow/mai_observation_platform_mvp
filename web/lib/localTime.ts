/**
 * Human-readable LOCAL-TIME fields for the machine API (C-6). UTC stays the canonical
 * wire value — these are ADDED so an n8n AI agent never converts timezones itself. Pure
 * Intl (Node 22 ships full ICU): no dependency, no offset tables. ONE helper, so a new
 * locale is a one-line change and every response formats identically.
 *
 * `tz` is an IANA name (the SITE's timezone by default — an appointment happens at a
 * physical place). It affects PRESENTATION ONLY; it never changes stored values or what
 * the engine considers available.
 */

/** A real IANA timezone? (Intl throws RangeError on an unknown name.) */
export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A locale the runtime's Intl data actually supports? (empty best-fit ⇒ unsupported) */
export function isSupportedLocale(locale: string): boolean {
  if (!locale) return false;
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0;
  } catch {
    return false;
  }
}

/** ISO-8601 WITH the local offset, e.g. "2026-08-04T17:00:00-05:00" — the wall clock in
 *  `tz` plus that instant's real offset (DST-correct: the offset is read for THIS
 *  instant, not a fixed table). */
export function localIsoWithOffset(instant: Date, tz: string): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "longOffset",
  });
  const p = dtf.formatToParts(instant);
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? "";
  const raw = g("timeZoneName"); // "GMT-05:00" | "GMT+05:30" | "GMT" (UTC)
  const offset = raw === "GMT" || raw === "" ? "+00:00" : raw.replace("GMT", "");
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}:${g("second")}${offset}`;
}

/** The local calendar date "YYYY-MM-DD" in `tz` (en-CA renders ISO order). This is the
 *  LOCAL date — a 02:00Z instant is still the previous day in Bogotá. */
export function localDay(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(instant);
}

/** A short spoken time, 12-hour with a.m./p.m., in `locale`+`tz`, e.g. es-CO "5:00 p. m." */
export function timeLabel(instant: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(instant);
}

/** A spoken date, e.g. es-CO "martes, 4 de agosto". */
export function dateLabel(instant: Date, tz: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(instant);
}

/** The 24-hour wall clock "HH:MM" in `tz` (locale-independent — the canonical value a
 *  caller passes back as `time`). */
export function localClock24(instant: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
}

export interface LocalTimeFields {
  start_local: string;
  end_local: string;
  start_label: string;
  end_label: string;
  date_label: string;
  day: string;
}

/** The six additive fields for an interval [start, end] in `tz`/`locale`. `date_label`
 *  and `day` follow the START's local date. */
export function localTimeFields(start: Date, end: Date, tz: string, locale: string): LocalTimeFields {
  return {
    start_local: localIsoWithOffset(start, tz),
    end_local: localIsoWithOffset(end, tz),
    start_label: timeLabel(start, tz, locale),
    end_label: timeLabel(end, tz, locale),
    date_label: dateLabel(start, tz, locale),
    day: localDay(start, tz),
  };
}

export interface LocalStartFields {
  start_local: string;
  start_label: string;
  date_label: string;
  day: string;
}

/** The start-only labels for a single instant with no known end (e.g. a contact's
 *  next_appointment). Composed from the SAME primitives as localTimeFields — one source
 *  of formatting. */
export function localStartFields(start: Date, tz: string, locale: string): LocalStartFields {
  return {
    start_local: localIsoWithOffset(start, tz),
    start_label: timeLabel(start, tz, locale),
    date_label: dateLabel(start, tz, locale),
    day: localDay(start, tz),
  };
}

/** Labels for a point-in-time that is a moment, not a slot (e.g. a note's created_at):
 *  the offset-ISO plus a spoken "date, time". Same primitives, no second formatter. */
export function localMomentFields(instant: Date, tz: string, locale: string): { local: string; label: string } {
  return {
    local: localIsoWithOffset(instant, tz),
    label: `${dateLabel(instant, tz, locale)}, ${timeLabel(instant, tz, locale)}`,
  };
}

export const DEFAULT_LABEL_LOCALE = "es-CO";
