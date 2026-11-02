import { intersect, normalize, type Span } from '../scheduling/intervals.js';
import { utcToZonedParts, zonedPartsToUtc } from '../scheduling/timezone.js';
import { getSiteById } from '../db/repositories/scheduling/sites.js';
import { enumerateLocalDays, loadStaffDays, parseDay } from './compute.js';
import type { AppointmentStatus } from '../db/repositories/scheduling/appointments.js';

/**
 * JP-8 §2 — the reserved-occupancy HEATMAP, computed ON DEMAND for the selected range (not from the
 * daily rollup, which has no hour granularity). For each cell (weekday × hour) it sums, across the
 * range, the available shift minutes and the booked SERVICE minutes (clipped to the shift), reusing
 * the SAME engine inputs as the rollup. Weekdays are Monday-first (Mon=0 … Sun=6); hours 0–23 in the
 * site's local time. The caller turns booked/available into a percentage for display.
 *
 * Hour boundaries are taken as local-midnight + h hours (the same fixed-offset convention the
 * availability engine uses), so the heatmap agrees with capacity even on a DST-transition day.
 */

const BOOKED: ReadonlySet<AppointmentStatus> = new Set(['scheduled', 'confirmed', 'completed', 'no_show']);
const WEEKDAY_MON0: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };

export interface HeatmapCell {
  availableMin: number;
  bookedMin: number;
}

export interface OccupancyHeatmap {
  /** [weekday 0=Mon..6=Sun][hour 0..23]. */
  grid: HeatmapCell[][];
  fromDay: string;
  toDay: string;
}

const overlapMin = (span: Span, cellStart: number, cellEnd: number): number =>
  Math.max(0, Math.min(span.end, cellEnd) - Math.max(span.start, cellStart)) / 60000;

function emptyGrid(): HeatmapCell[][] {
  return Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ availableMin: 0, bookedMin: 0 })));
}

/** Build the heatmap for a SITE (all given professionals of one site) or a single professional, over
 *  [fromDay, toDay] inclusive. `staffIds` must belong to `siteId`. */
export async function buildOccupancyHeatmap(params: {
  tenantId: string;
  clientId: string;
  siteId: string;
  staffIds: string[];
  fromDay: string;
  toDay: string;
}): Promise<OccupancyHeatmap> {
  const { tenantId, clientId, siteId, staffIds, fromDay, toDay } = params;
  const grid = emptyGrid();
  const site = await getSiteById(tenantId, siteId);
  if (!site || staffIds.length === 0) return { grid, fromDay, toDay };
  const tz = site.timezone;
  const days = enumerateLocalDays(fromDay, toDay, tz);
  if (days.length === 0) return { grid, fromDay, toDay };

  // Per local day: its weekday (Mon=0) and the 25 hour boundaries (local-midnight + h hours).
  const dayMeta = new Map<string, { weekday: number; bounds: number[] }>();
  for (const day of days) {
    const p = parseDay(day);
    const midnight = zonedPartsToUtc(p.year, p.month, p.day, 0, 0, tz).getTime();
    const weekday = WEEKDAY_MON0[utcToZonedParts(new Date(midnight + 12 * 3600000), tz).weekday] ?? 0;
    const bounds = Array.from({ length: 25 }, (_, h) => midnight + h * 3600000);
    dayMeta.set(day, { weekday, bounds });
  }

  const addSpans = (spans: Span[], day: string, key: 'availableMin' | 'bookedMin'): void => {
    const meta = dayMeta.get(day);
    if (!meta) return;
    for (const span of spans) {
      for (let h = 0; h < 24; h++) {
        const mins = overlapMin(span, meta.bounds[h], meta.bounds[h + 1]);
        if (mins > 0) grid[meta.weekday][h][key] += mins;
      }
    }
  };

  for (const staffId of staffIds) {
    const load = await loadStaffDays(tenantId, clientId, siteId, staffId, days);
    if (!load) continue;
    for (const day of days) {
      const shift = normalize(load.shiftByDay.get(day) ?? []);
      if (shift.length > 0) addSpans(shift, day, 'availableMin');
      const appts = load.apptsByDay.get(day) ?? [];
      const bookedInside: Span[] = [];
      for (const a of appts) {
        if (a.endMs <= a.startMs || !BOOKED.has(a.status)) continue;
        for (const s of intersect([{ start: a.startMs, end: a.endMs }], shift)) bookedInside.push(s);
      }
      if (bookedInside.length > 0) addSpans(bookedInside, day, 'bookedMin');
    }
  }

  // Round to whole minutes (fixed-offset hour bounds keep these exact off DST days).
  for (const row of grid) for (const cell of row) {
    cell.availableMin = Math.round(cell.availableMin);
    cell.bookedMin = Math.round(cell.bookedMin);
  }
  return { grid, fromDay, toDay };
}
