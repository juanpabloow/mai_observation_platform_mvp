/**
 * The PHONE agenda's pure logic — what the list shows, in which order, and what is
 * "next" — kept out of the component so it is unit-tested (test/unit/mobileAgenda.test.ts).
 * No path aliases on purpose: tests import this file directly.
 *
 * Everything is computed in the SITE's timezone. Nothing here decides availability:
 * blocks and closed days are drawn as facts; bookable times come from the engine.
 */

export interface MAppt {
  id: string;
  staff_id: string;
  start_at: string;
  service_end_at: string;
  status: string;
}

export interface MBlock {
  id: string;
  staff_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export type DayItem<A extends MAppt> =
  | { kind: "appt"; at: number; appt: A; isNext: boolean }
  | { kind: "block"; at: number; block: MBlock; from: number; to: number }
  | { kind: "now"; at: number };

const LIVE = new Set(["scheduled", "confirmed"]);

/** Site-local day key + minutes from midnight for an instant. */
export function zoned(iso: string | Date, tz: string): { dayKey: string; min: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(typeof iso === "string" ? new Date(iso) : iso);
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "0";
  return { dayKey: `${get("year")}-${get("month")}-${get("day")}`, min: Number(get("hour")) * 60 + Number(get("minute")) };
}

export const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * One day, chronologically: appointments, the blocks that touch it (site-wide ones, and
 * a professional's own when that professional is in view), and — only when the day is
 * TODAY at the site — a "now" marker at the current minute. `isNext` marks the first
 * live appointment that has not started yet.
 */
export function buildDay<A extends MAppt>(
  appts: readonly A[],
  blocks: readonly MBlock[],
  dayKey: string,
  tz: string,
  now: Date,
  opts: { staffInView?: readonly string[] | null } = {},
): { items: DayItem<A>[]; nextId: string | null; blockCount: number } {
  const nowZ = zoned(now, tz);
  const isToday = nowZ.dayKey === dayKey;
  const inView = opts.staffInView && opts.staffInView.length > 0 ? new Set(opts.staffInView) : null;
  const dayAppts = appts
    .filter((a) => zoned(a.start_at, tz).dayKey === dayKey)
    .sort((x, y) => x.start_at.localeCompare(y.start_at));
  const nextId = isToday
    ? dayAppts.find((a) => LIVE.has(a.status) && new Date(a.start_at).getTime() >= now.getTime())?.id ?? null
    : null;
  const items: DayItem<A>[] = dayAppts.map((a) => ({ kind: "appt", at: zoned(a.start_at, tz).min, appt: a, isNext: a.id === nextId }));
  let blockCount = 0;
  for (const b of blocks) {
    if (b.staff_id !== null && inView && !inView.has(b.staff_id)) continue;
    const s = zoned(b.starts_at, tz);
    const e = zoned(b.ends_at, tz);
    if (s.dayKey > dayKey || e.dayKey < dayKey) continue;
    const from = s.dayKey === dayKey ? s.min : 0;
    const to = e.dayKey === dayKey ? e.min : 24 * 60;
    if (to <= from) continue;
    blockCount++;
    items.push({ kind: "block", at: from, block: b, from, to });
  }
  if (isToday) items.push({ kind: "now", at: nowZ.min });
  // Stable chronological order; at the same minute: now → block → appointment, so the
  // "Ahora" line sits above what starts at this minute.
  const rank = { now: 0, block: 1, appt: 2 } as const;
  items.sort((x, y) => x.at - y.at || rank[x.kind] - rank[y.kind]);
  return { items, nextId, blockCount };
}

/** "en 18 min", "en 1 h", "en 2 h 5 min" — the "SIGUIENTE" countdown. */
export function untilLabel(fromMs: number, toMs: number): string {
  const m = Math.max(0, Math.round((toMs - fromMs) / 60000));
  if (m < 60) return `en ${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `en ${h} h ${r} min` : `en ${h} h`;
}

export interface WeekDay<A extends MAppt> {
  dayKey: string;
  appts: A[];
  shown: A[];
  /** Appointments not drawn in the group — reached through "Ver las N citas". */
  hidden: number;
  closed: boolean;
}

/**
 * The week, grouped by day: at most `limit` rows per day are drawn, the rest stay one
 * tap away ("Ver las N citas del …" opens that day). A closed day with no appointments
 * says so; a closed day that still HAS appointments shows them (they exist).
 */
export function groupWeek<A extends MAppt>(
  appts: readonly A[],
  dayKeys: readonly string[],
  tz: string,
  isClosed: (dayKey: string) => boolean,
  limit = 3,
): WeekDay<A>[] {
  return dayKeys.map((dayKey) => {
    const list = appts.filter((a) => zoned(a.start_at, tz).dayKey === dayKey).sort((x, y) => x.start_at.localeCompare(y.start_at));
    const many = list.length > limit + 1; // never hide just ONE row behind a button
    const shown = many ? list.slice(0, limit) : list;
    return { dayKey, appts: list, shown, hidden: list.length - shown.length, closed: isClosed(dayKey) };
  });
}
