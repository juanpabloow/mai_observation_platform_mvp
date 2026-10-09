/**
 * Site-local calendar helpers for the PUBLIC booking page — pure, no I/O, no React.
 *
 * Every day key ("YYYY-MM-DD"), hour and month here is the SITE's local time, never the
 * browser's: a customer in Madrid booking a barber in Bogotá must see Bogotá's hours.
 * Same rules (and same algorithms) as the internal agenda's helpers in
 * components/scheduling/AgendaView.tsx, which keeps its own copies because its source
 * contract tests pin them inside that file.
 */

export type DayKey = string; // YYYY-MM-DD
export type MonthKey = string; // YYYY-MM

const WEEKDAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** YYYY-MM-DD arithmetic that never touches the local timezone. */
export function addDays(day: DayKey, days: number): DayKey {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function shiftMonth(month: MonthKey, delta: number): MonthKey {
  const [y, m] = month.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Whole months from `a` to `b` (b − a). */
export function monthDiff(a: MonthKey, b: MonthKey): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am);
}

/** The site-local day of an instant. */
export function siteDayKey(iso: string | Date, timeZone: string): DayKey {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(typeof iso === "string" ? new Date(iso) : iso);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function todayAtSite(timeZone: string, now: Date = new Date()): DayKey {
  return siteDayKey(now, timeZone);
}

/** The site-local wall-clock hour of an instant (0–23). */
export function siteHour(iso: string, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  return Number(h);
}

/** Local midnight of a site day, as a UTC instant. Two passes cover DST boundaries. */
export function siteMidnight(day: DayKey, timeZone: string): Date {
  const [year, month, d] = day.split("-").map(Number);
  const naive = Date.UTC(year, month - 1, d, 0, 0, 0);
  const offsetAt = (instant: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - instant;
  };
  const first = naive - offsetAt(naive);
  return new Date(naive - offsetAt(first));
}

/** Monday-first month grid, padded to whole weeks. */
export function calendarDays(month: MonthKey): Array<{ key: DayKey; day: number; inMonth: boolean }> {
  const first = `${month}-01`;
  const [y, m] = month.split("-").map(Number);
  const mondayOffset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const start = addDays(first, -mondayOffset);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const cells = Math.ceil((mondayOffset + daysInMonth) / 7) * 7;
  return Array.from({ length: cells }, (_, i) => {
    const key = addDays(start, i);
    return { key, day: Number(key.slice(8, 10)), inMonth: key.startsWith(month) };
  });
}

export function weekdayKeyOf(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * The availability windows that cover the bookable part of a month, each at most
 * `maxDays` long (the public endpoint's 14-day cap). Starts at the later of the month's
 * first day and today, ends at the next month's first day — all at site midnight.
 * Empty when the whole month is in the past.
 */
export function monthSegments(
  month: MonthKey,
  today: DayKey,
  timeZone: string,
  maxDays = 14,
): Array<{ from: Date; to: Date }> {
  const monthStart = `${month}-01`;
  const monthEnd = `${shiftMonth(month, 1)}-01`;
  let cursor = today > monthStart ? today : monthStart;
  const out: Array<{ from: Date; to: Date }> = [];
  while (cursor < monthEnd) {
    const next = addDays(cursor, maxDays) < monthEnd ? addDays(cursor, maxDays) : monthEnd;
    out.push({ from: siteMidnight(cursor, timeZone), to: siteMidnight(next, timeZone) });
    cursor = next;
  }
  return out;
}

// ── Spanish labels ──────────────────────────────────────────────────────────────

export type HourFormat = "24" | "12";

/** Wall clock in the site's timezone. 24-hour by default ("09:00", "15:30"); the visitor
 * may switch to 12-hour ("9:00 a. m.", "3:30 p. m."), always in the site's zone. */
export function fmtTime(iso: string, timeZone: string, format: HourFormat = "24"): string {
  if (format === "12") {
    const p = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h12" }).formatToParts(new Date(iso));
    const get = (t: string) => p.find((x) => x.type === t)?.value ?? "";
    return `${get("hour")}:${get("minute")} ${get("dayPeriod").toUpperCase() === "AM" ? "a. m." : "p. m."}`;
  }
  return new Intl.DateTimeFormat("es", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}

const capitalize = (s: string) => (s ? s.charAt(0).toLocaleUpperCase("es") + s.slice(1) : s);

/** "Martes 14 de octubre" for a site day key (formatted in UTC, so it cannot shift). */
export function dayHeadline(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  const raw = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.UTC(y, m - 1, d)))
    .replace(",", "");
  return capitalize(raw);
}

/** "mié 14 oct" — the compact form for the running summary. Deterministic labels
 * (not Intl's "sept."/"sep" drift). */
const SHORT_WEEKDAYS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
const SHORT_MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
export function dayShort(day: DayKey): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${SHORT_WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${SHORT_MONTHS[m - 1]}`;
}

/** "Martes 14 de octubre de 2026" for an instant at the site. */
export function longDate(iso: string, timeZone: string): string {
  const raw = new Intl.DateTimeFormat("es-CO", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone })
    .format(new Date(iso))
    .replace(",", "");
  return capitalize(raw);
}

/** "Octubre 2026". */
export function monthTitle(month: MonthKey): string {
  const raw = new Intl.DateTimeFormat("es-CO", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${month}-01T00:00:00Z`))
    .replace(" de ", " ");
  return capitalize(raw);
}

/** "GMT-5" for a timezone, right now. */
export function gmtLabel(timeZone: string, now: Date = new Date()): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  return name ?? "";
}

/** "Bogotá (GMT-5)" — the city part of an IANA name, readable. */
export function timezoneLabel(timeZone: string, now: Date = new Date()): string {
  const city = (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
  const known: Record<string, string> = { Bogota: "Bogotá", Mexico_City: "Ciudad de México", Panama: "Panamá" };
  const pretty = known[timeZone.split("/").pop() ?? ""] ?? city;
  const offset = gmtLabel(timeZone, now);
  return offset ? `${pretty} (${offset})` : pretty;
}
