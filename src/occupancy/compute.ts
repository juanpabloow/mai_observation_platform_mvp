import { intersect, normalize, type Span } from '../scheduling/intervals.js';
import { explainStaffStatus } from '../scheduling/availabilityExplain.js';
import { localDatesInRange, utcToZonedParts, zonedPartsToUtc } from '../scheduling/timezone.js';
import { getSiteById } from '../db/repositories/scheduling/sites.js';
import { getStaffById } from '../db/repositories/scheduling/staff.js';
import { loadExplainExceptions } from '../db/repositories/scheduling/availabilityData.js';
import {
  collectedServiceByDay,
  deleteStaffDayOccupancy,
  listAppointmentsForOccupancy,
  upsertStaffDayOccupancy,
  type OccupancyMetrics,
} from '../db/repositories/scheduling/occupancy.js';
import type { AppointmentStatus } from '../db/repositories/scheduling/appointments.js';

/**
 * JP-8 §1 — the occupancy MATH. `occupancyMinutesForDay` is pure (no DB/clock): given the day's
 * available shift spans (from the SAME engine the bot uses) and the day's appointments, it returns
 * the minute buckets. `recomputeStaffDays` wires it to the DB: load capacity + appointments +
 * recorded service money, compute each requested day, and upsert the rollup (deleting a day that
 * turns out fully empty). Idempotent — recompute always overwrites from source.
 *
 * Minute rules (operator's definition):
 *  - available = Σ shift (working ∩ site − breaks − time off − closures); NOT minus appointments.
 *  - occupied counts SERVICE duration only (start_at..service_end_at); buffers are never occupied.
 *  - reservada statuses = scheduled|confirmed|completed|no_show; atendida = completed; no_show the gap.
 *  - cancelled never counts anywhere.
 *  - each appointment's service window is CLIPPED to the shift: the inside part is booked minutes;
 *    the rest (before opening, after closing, during a break, on a day off, via a time-correction)
 *    is "fuera de horario" — reported, never inflating the percentage.
 */

export interface OccupancyApptInput {
  startMs: number;
  endMs: number;
  status: AppointmentStatus;
}

export interface OccupancyMinutes {
  availableMin: number;
  bookedMin: number;
  attendedMin: number;
  noShowMin: number;
  outsideHoursMin: number;
}

const BOOKED_STATUSES: ReadonlySet<AppointmentStatus> = new Set(['scheduled', 'confirmed', 'completed', 'no_show']);
const totalMs = (spans: Span[]): number => spans.reduce((s, x) => s + (x.end - x.start), 0);
const toMin = (ms: number): number => Math.round(ms / 60000);

export function occupancyMinutesForDay(shift: Span[], appts: OccupancyApptInput[]): OccupancyMinutes {
  const shiftN = normalize(shift);
  let bookedMs = 0;
  let attendedMs = 0;
  let noShowMs = 0;
  let outsideMs = 0;
  for (const a of appts) {
    if (a.endMs <= a.startMs) continue;
    if (!BOOKED_STATUSES.has(a.status)) continue; // cancelled (and anything else) never counts
    const serviceMs = a.endMs - a.startMs;
    const insideMs = totalMs(intersect([{ start: a.startMs, end: a.endMs }], shiftN));
    bookedMs += insideMs;
    outsideMs += Math.max(0, serviceMs - insideMs);
    if (a.status === 'completed') attendedMs += insideMs;
    else if (a.status === 'no_show') noShowMs += insideMs;
  }
  return {
    availableMin: toMin(totalMs(shiftN)),
    bookedMin: toMin(bookedMs),
    attendedMin: toMin(attendedMs),
    noShowMin: toMin(noShowMs),
    outsideHoursMin: toMin(outsideMs),
  };
}

// ── local-day helpers (site timezone) ───────────────────────────────────────────────

const pad = (n: number): string => String(n).padStart(2, '0');
export function parseDay(s: string): { year: number; month: number; day: number } {
  const [y, m, d] = s.split('-').map(Number);
  return { year: y, month: m, day: d };
}
function localMidnight(dayStr: string, tz: string): Date {
  const p = parseDay(dayStr);
  return zonedPartsToUtc(p.year, p.month, p.day, 0, 0, tz);
}
function localMidnightAfter(dayStr: string, tz: string): Date {
  const base = localMidnight(dayStr, tz);
  const probe = new Date(base.getTime() + 26 * 3600 * 1000); // cross DST robustly, then snap
  const p = utcToZonedParts(probe, tz);
  return zonedPartsToUtc(p.year, p.month, p.day, 0, 0, tz);
}
export function localDayKey(d: Date, tz: string): string {
  const p = utcToZonedParts(d, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The inclusive list of site-local day strings from `startDay` to `endDay` (both "YYYY-MM-DD"). */
export function enumerateLocalDays(startDay: string, endDay: string, tz: string): string[] {
  const from = localMidnight(startDay, tz);
  const to = localMidnightAfter(endDay, tz); // exclusive upper bound = local midnight after endDay
  if (to.getTime() <= from.getTime()) return [];
  return localDatesInRange(from, to, tz)
    .map((d) => `${d.year}-${pad(d.month)}-${pad(d.day)}`)
    .filter((s) => s >= startDay && s <= endDay);
}

/** The engine inputs for a professional over a set of local days: the site timezone, the available
 *  shift per day (reused by both the rollup and the heatmap), and the day's appointments bucketed by
 *  local day. `null` when the source is gone (site/staff deleted or the staff moved sites). */
export interface StaffDaysLoad {
  tz: string;
  shiftByDay: Map<string, Span[]>;
  apptsByDay: Map<string, OccupancyApptInput[]>;
}

export async function loadStaffDays(
  tenantId: string,
  clientId: string,
  siteId: string,
  staffId: string,
  days: string[],
): Promise<StaffDaysLoad | null> {
  if (days.length === 0) return { tz: 'UTC', shiftByDay: new Map(), apptsByDay: new Map() };
  const uniqueDays = [...new Set(days)].sort();
  const site = await getSiteById(tenantId, siteId);
  const staff = await getStaffById(tenantId, staffId);
  if (!site || !staff || staff.site_id !== siteId) return null;
  const tz = site.timezone;
  const from = localMidnight(uniqueDays[0], tz);
  const to = localMidnightAfter(uniqueDays[uniqueDays.length - 1], tz);

  const exc = await loadExplainExceptions({ tenantId, siteId, from, to, staffIds: [staffId] });
  const statuses = explainStaffStatus({
    site: { timezone: tz, opening_hours: site.opening_hours },
    staff: { id: staffId, working_hours: staff.working_hours },
    dates: uniqueDays.map(parseDay),
    siteExceptions: exc.site,
    staffExceptions: exc.staff.get(staffId) ?? [],
    breaks: [...exc.siteBreaks, ...(exc.staffBreaks.get(staffId) ?? [])],
  });
  const shiftByDay = new Map<string, Span[]>(
    statuses.map((s) => [s.date, s.shift.map((x) => ({ start: x.from.getTime(), end: x.until.getTime() }))]),
  );

  const appts = await listAppointmentsForOccupancy(tenantId, clientId, staffId, from, to);
  const apptsByDay = new Map<string, OccupancyApptInput[]>();
  for (const a of appts) {
    const key = localDayKey(a.start_at, tz);
    const list = apptsByDay.get(key) ?? [];
    list.push({ startMs: a.start_at.getTime(), endMs: a.service_end_at.getTime(), status: a.status });
    apptsByDay.set(key, list);
  }
  return { tz, shiftByDay, apptsByDay };
}

/**
 * Recompute the rollup for one professional on a specific set of local days. Reuses the availability
 * engine (`loadExplainExceptions` + `explainStaffStatus`) for capacity, so the numbers can never
 * diverge from what the bot/booking page offer. Writes a row per non-empty day; deletes an empty one.
 */
export async function recomputeStaffDays(
  tenantId: string,
  clientId: string,
  siteId: string,
  staffId: string,
  days: string[],
): Promise<void> {
  if (days.length === 0) return;
  const uniqueDays = [...new Set(days)].sort();

  const load = await loadStaffDays(tenantId, clientId, siteId, staffId, uniqueDays);
  // Source gone (site/staff deleted, or staff moved sites): the day has no capacity here — clear it.
  if (!load) {
    for (const day of uniqueDays) await deleteStaffDayOccupancy({ tenantId, clientId, siteId, staffId, day });
    return;
  }
  const { tz, shiftByDay, apptsByDay } = load;
  const from = localMidnight(uniqueDays[0], tz);
  const to = localMidnightAfter(uniqueDays[uniqueDays.length - 1], tz);
  const collected = await collectedServiceByDay(tenantId, clientId, staffId, from, to, tz);

  for (const day of uniqueDays) {
    const minutes = occupancyMinutesForDay(shiftByDay.get(day) ?? [], apptsByDay.get(day) ?? []);
    const collectedAmount = collected.get(day) ?? '0';
    const metrics: OccupancyMetrics = { ...minutes, collectedAmount };
    const empty =
      minutes.availableMin === 0 &&
      minutes.bookedMin === 0 &&
      minutes.attendedMin === 0 &&
      minutes.noShowMin === 0 &&
      minutes.outsideHoursMin === 0 &&
      Number(collectedAmount) === 0;
    if (empty) await deleteStaffDayOccupancy({ tenantId, clientId, siteId, staffId, day });
    else await upsertStaffDayOccupancy({ tenantId, clientId, siteId, staffId, day }, metrics);
  }
}
