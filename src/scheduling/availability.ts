import { intersect, normalize, subtract, type Span } from './intervals.js';
import {
  localDatesInRange,
  parseHhMm,
  utcToZonedParts,
  zonedPartsToUtc,
  type Weekday,
} from './timezone.js';
import type { AvailabilityRequest, Slot, StaffAvailabilityInput, WeeklyHours } from './types.js';

const MS_PER_MIN = 60_000;

/** UTC spans for a weekday's local ranges on a specific local date. */
function hoursToSpans(
  hours: WeeklyHours,
  date: { year: number; month: number; day: number },
  weekday: Weekday,
  timeZone: string,
): Span[] {
  const ranges = hours[weekday] ?? [];
  return ranges.map((r) => {
    const s = parseHhMm(r.start);
    const e = parseHhMm(r.end);
    const start = zonedPartsToUtc(date.year, date.month, date.day, Math.floor(s / 60), s % 60, timeZone);
    // end may be 24:00 → represent as next-midnight via minutes offset from midnight.
    const startOfDay = zonedPartsToUtc(date.year, date.month, date.day, 0, 0, timeZone);
    const end = new Date(startOfDay.getTime() + e * MS_PER_MIN);
    return { start: start.getTime(), end: end.getTime() };
  });
}

function toSpans(ranges: Array<{ from: Date; until: Date }>): Span[] {
  return ranges.map((r) => ({ start: r.from.getTime(), end: r.until.getTime() }));
}

/**
 * THE availability engine — PURE (no DB, no clock; `now` is injected).
 *
 *   effective = (site opening ∩ staff working) − site exceptions − staff
 *               exceptions − staff active appointments
 * then, per free interval, discretize candidate starts on the slot grid (aligned
 * to local midnight) and keep a start S iff the FULL blocked window
 * [S − buffer_before, S + duration + buffer_after) fits inside the free interval
 * (so service + buffers never cross a closure, break, or exception). Finally
 * filter by min_notice and booking_horizon.
 *
 * "Any staff": a slot offered by multiple staff is returned ONCE, its staff_id
 * chosen deterministically — fewest active appointments that local day, then
 * lowest id (never "always the first row") — with available_staff_ids listing all.
 */
export function computeAvailability(req: AvailabilityRequest): Slot[] {
  const { site, service, now } = req;
  const cfg = site.scheduling_config;
  const slotMs = cfg.slot_interval_min * MS_PER_MIN;
  const durMs = service.duration_min * MS_PER_MIN;
  const bufBeforeMs = service.buffer_before_min * MS_PER_MIN;
  const bufAfterMs = service.buffer_after_min * MS_PER_MIN;
  const blockMs = bufBeforeMs + durMs + bufAfterMs;

  const rangeStart = req.from.getTime();
  const rangeEnd = req.to.getTime();
  const minStart = now.getTime() + cfg.min_notice_min * MS_PER_MIN;
  const maxStart = now.getTime() + cfg.booking_horizon_days * 24 * 60 * MS_PER_MIN;

  const dates = localDatesInRange(req.from, req.to, site.timezone);
  const siteExc = toSpans(req.siteExceptions);

  // Precompute per-staff active-appointment count PER local day for the tie-break.
  const dayKey = (d: Date): string => {
    const p = utcToZonedParts(d, site.timezone);
    return `${p.year}-${p.month}-${p.day}`;
  };
  const staffDayLoad = new Map<string, Map<string, number>>();
  for (const st of req.staff) {
    const perDay = new Map<string, number>();
    for (const b of st.busy) {
      const k = dayKey(b.from);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    staffDayLoad.set(st.id, perDay);
  }

  // start_at epoch ms → { available: staffId[] }
  const byStart = new Map<number, { available: string[] }>();

  for (const date of dates) {
    // The weekday of this local date.
    const noon = zonedPartsToUtc(date.year, date.month, date.day, 12, 0, site.timezone);
    const weekday = utcToZonedParts(noon, site.timezone).weekday;
    const siteOpen = normalize(hoursToSpans(site.opening_hours, date, weekday, site.timezone));
    if (siteOpen.length === 0) continue;

    for (const st of req.staff) {
      // Staff working hours: {} (no weekday keys) means "inherit site opening".
      const hasOwnHours = Object.keys(st.working_hours).length > 0;
      const staffWork = hasOwnHours
        ? normalize(hoursToSpans(st.working_hours, date, weekday, site.timezone))
        : siteOpen;

      let free = intersect(siteOpen, staffWork);
      free = subtract(free, siteExc);
      free = subtract(free, toSpans(st.exceptions));
      free = subtract(free, toSpans(st.busy));

      for (const span of free) {
        // Grid-align candidate starts to local midnight of this date.
        const midnight = zonedPartsToUtc(date.year, date.month, date.day, 0, 0, site.timezone).getTime();
        const firstStart = span.start + bufBeforeMs; // earliest S so blocked_from ≥ span.start
        // Snap up to the next slot-grid tick ≥ firstStart.
        const offset = firstStart - midnight;
        const aligned = midnight + Math.ceil(offset / slotMs) * slotMs;

        for (let s = aligned; s + durMs + bufAfterMs <= span.end; s += slotMs) {
          const blockedFrom = s - bufBeforeMs;
          const blockedUntil = s + durMs + bufAfterMs;
          if (blockedFrom < span.start || blockedUntil > span.end) continue; // must fit fully
          if (s < rangeStart || s + durMs > rangeEnd) continue; // within requested window
          if (s < minStart || s > maxStart) continue; // min-notice + horizon
          void blockMs;
          const entry = byStart.get(s) ?? { available: [] };
          entry.available.push(st.id);
          byStart.set(s, entry);
        }
      }
    }
  }

  const slots: Slot[] = [];
  for (const [start, { available }] of [...byStart.entries()].sort((a, b) => a[0] - b[0])) {
    const startDate = new Date(start);
    const chosen = chooseStaff(available, startDate, staffDayLoad, dayKey);
    slots.push({
      start_at: startDate,
      service_end_at: new Date(start + durMs),
      staff_id: chosen,
      available_staff_ids: [...available].sort(),
    });
  }
  return slots;
}

/** Deterministic "any" pick: fewest active appts that local day, then lowest id. */
function chooseStaff(
  candidates: string[],
  when: Date,
  staffDayLoad: Map<string, Map<string, number>>,
  dayKey: (d: Date) => string,
): string {
  const k = dayKey(when);
  return [...candidates].sort((a, b) => {
    const la = staffDayLoad.get(a)?.get(k) ?? 0;
    const lb = staffDayLoad.get(b)?.get(k) ?? 0;
    if (la !== lb) return la - lb;
    return a < b ? -1 : a > b ? 1 : 0;
  })[0];
}

/** Effective timing for a service given optional site/staff duration overrides and
 * the service's own buffers (site scheduling_config supplies buffer defaults only
 * when the service leaves them at zero AND no explicit service buffer is set). */
export function resolveServiceTiming(
  base: { duration_min: number; buffer_before_min: number; buffer_after_min: number },
  overrides: { duration_override_min?: number | null },
): { duration_min: number; buffer_before_min: number; buffer_after_min: number } {
  return {
    duration_min: overrides.duration_override_min ?? base.duration_min,
    buffer_before_min: base.buffer_before_min,
    buffer_after_min: base.buffer_after_min,
  };
}

export type { StaffAvailabilityInput };
