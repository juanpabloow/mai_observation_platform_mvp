/**
 * JP-8 §3 — pure view-model for the Ocupación screen: the period math (Día/Semana/Mes, Monday weeks,
 * calendar months), the percentage/formatting helpers, and the row assembly. No DB, no React, no
 * clock — so it is unit-testable and the server loader stays thin. Money fields are OPTIONAL and are
 * only ever populated when the caller passes `canMoney` (the server enforces this — §4).
 */

export type OccupancyGranularity = 'day' | 'week' | 'month';

const pad = (n: number): string => String(n).padStart(2, '0');
const toUTC = (day: string): Date => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)); // noon UTC — a safe anchor for calendar arithmetic
};
const fromUTC = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
/** Calendar weekday, Monday=0 … Sunday=6 (tz-independent — it is the day's own weekday). */
export function weekdayMon0(day: string): number {
  return (toUTC(day).getUTCDay() + 6) % 7;
}
function addDays(day: string, n: number): string {
  return fromUTC(new Date(toUTC(day).getTime() + n * 86_400_000));
}
function lastOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

export interface Period {
  granularity: OccupancyGranularity;
  anchor: string; // any local day inside the period
  from: string;
  to: string;
}

/** The inclusive [from, to] a granularity+anchor covers. Weeks start Monday; months are calendar. */
export function periodRange(granularity: OccupancyGranularity, anchor: string): Period {
  if (granularity === 'day') return { granularity, anchor, from: anchor, to: anchor };
  if (granularity === 'week') {
    const from = addDays(anchor, -weekdayMon0(anchor));
    return { granularity, anchor, from, to: addDays(from, 6) };
  }
  const [y, m] = anchor.split('-').map(Number);
  const from = `${y}-${pad(m)}-01`;
  return { granularity, anchor, from, to: lastOfMonth(from) };
}

/** Move the anchor one whole period earlier/later (dir = −1 / +1). */
export function shiftPeriod(granularity: OccupancyGranularity, anchor: string, dir: -1 | 1): string {
  if (granularity === 'day') return addDays(anchor, dir);
  if (granularity === 'week') return addDays(anchor, dir * 7);
  const [y, m, d] = anchor.split('-').map(Number);
  const nextFirst = new Date(Date.UTC(y, m - 1 + dir, 1, 12));
  // Keep the day-of-month where possible (clamped to the new month's length).
  const clampedDay = Math.min(d, new Date(Date.UTC(nextFirst.getUTCFullYear(), nextFirst.getUTCMonth() + 1, 0)).getUTCDate());
  return `${nextFirst.getUTCFullYear()}-${pad(nextFirst.getUTCMonth() + 1)}-${pad(clampedDay)}`;
}

/** The start days of the last `count` periods ending at (and including) the period of `anchor` — for
 *  the trend sparkline. Oldest first. */
export function trendBucketStarts(granularity: OccupancyGranularity, anchor: string, count: number): string[] {
  const out: string[] = [];
  let a = anchor;
  for (let i = 0; i < count; i++) {
    out.unshift(periodRange(granularity, a).from);
    a = shiftPeriod(granularity, a, -1);
  }
  return out;
}

/** Reserved/attended occupancy %, 0–100, or null when there is no capacity (no working hours). */
export function occupancyPct(occupiedMin: number, availableMin: number): number | null {
  if (availableMin <= 0) return null;
  return Math.round((occupiedMin / availableMin) * 100);
}

export interface RawTotals {
  staff_id: string;
  available_min: number;
  booked_min: number;
  attended_min: number;
  no_show_min: number;
  outside_hours_min: number;
  collected_amount: string;
}
export interface RawBucket {
  staff_id: string;
  bucket: string;
  available_min: number;
  booked_min: number;
}

export interface OccupancyRow {
  staffId: string;
  name: string;
  availableMin: number;
  reservadaPct: number | null;
  atendidaPct: number | null;
  bookedMin: number;
  attendedMin: number;
  noShowMin: number;
  outsideHoursMin: number;
  freeMin: number;
  /** Reserved-occupancy % per trend bucket (oldest→newest), null where no capacity. */
  trend: Array<number | null>;
  /** Present ONLY for a money-permitted viewer. */
  collectedAmount?: string;
  salesPerAvailableHour?: number | null;
}

/**
 * Assemble one row per professional (+ a synthetic site-total row is the caller's job). `canMoney`
 * gates the money fields: when false they are OMITTED entirely, so a Setter/Staff payload carries no
 * money at all. A professional with no rollup data still gets a zeroed row.
 */
export function assembleRows(
  staff: Array<{ id: string; name: string }>,
  totals: Map<string, RawTotals>,
  freeByStaff: Map<string, number>,
  bucketsByStaff: Map<string, RawBucket[]>,
  trendStarts: string[],
  canMoney: boolean,
): OccupancyRow[] {
  return staff.map((p) => {
    const t = totals.get(p.id);
    const availableMin = t?.available_min ?? 0;
    const bookedMin = t?.booked_min ?? 0;
    const attendedMin = t?.attended_min ?? 0;
    const buckets = new Map((bucketsByStaff.get(p.id) ?? []).map((b) => [b.bucket, b]));
    const trend = trendStarts.map((start) => {
      const b = buckets.get(start);
      return b ? occupancyPct(b.booked_min, b.available_min) : null;
    });
    const row: OccupancyRow = {
      staffId: p.id,
      name: p.name,
      availableMin,
      bookedMin,
      attendedMin,
      noShowMin: t?.no_show_min ?? 0,
      outsideHoursMin: t?.outside_hours_min ?? 0,
      reservadaPct: occupancyPct(bookedMin, availableMin),
      atendidaPct: occupancyPct(attendedMin, availableMin),
      freeMin: freeByStaff.get(p.id) ?? 0,
      trend,
    };
    if (canMoney) {
      const collected = t?.collected_amount ?? '0';
      row.collectedAmount = collected;
      row.salesPerAvailableHour = availableMin > 0 ? Math.round(Number(collected) / (availableMin / 60)) : null;
    }
    return row;
  });
}

/** Sum the per-staff rows into the site-total row (money only when the rows carry it). */
export function siteTotalRow(rows: OccupancyRow[], canMoney: boolean): OccupancyRow {
  const sum = (f: (r: OccupancyRow) => number): number => rows.reduce((a, r) => a + f(r), 0);
  const availableMin = sum((r) => r.availableMin);
  const bookedMin = sum((r) => r.bookedMin);
  const attendedMin = sum((r) => r.attendedMin);
  const row: OccupancyRow = {
    staffId: '__site__',
    name: 'Toda la sede',
    availableMin,
    bookedMin,
    attendedMin,
    noShowMin: sum((r) => r.noShowMin),
    outsideHoursMin: sum((r) => r.outsideHoursMin),
    reservadaPct: occupancyPct(bookedMin, availableMin),
    atendidaPct: occupancyPct(attendedMin, availableMin),
    freeMin: sum((r) => r.freeMin),
    trend: [],
  };
  if (canMoney) {
    const collected = rows.reduce((a, r) => a + Number(r.collectedAmount ?? '0'), 0);
    row.collectedAmount = String(collected);
    row.salesPerAvailableHour = availableMin > 0 ? Math.round(collected / (availableMin / 60)) : null;
  }
  return row;
}

/** "7h 30m" / "45m" / "—" for a minute count (null/0 handled by the caller where "—" is wanted). */
export function hoursLabel(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
