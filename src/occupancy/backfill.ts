import { OCCUPANCY_FUTURE_DAYS, OCCUPANCY_PAST_DAYS } from './hooks.js';
import { enumerateLocalDays, localDayKey, recomputeStaffDays } from './compute.js';
import { earliestAppointmentForStaff, listBookableStaffTargets } from '../db/repositories/scheduling/occupancy.js';

/**
 * JP-8 §1 — the occupancy BACKFILL. Rebuilds the rollup for ALL existing history and the next 30
 * days, idempotently, for every bookable professional (optionally scoped to a tenant/client). Dry
 * run by default: it reports exactly the plan (professionals + (staff, day) pairs it WOULD compute)
 * without writing. `--apply` runs the same plan through `recomputeStaffDays`, which upserts a row
 * per non-empty day and clears empties — so a second apply is a no-op (same numbers overwritten).
 *
 * History start per professional = min(their earliest appointment's local day, today − 35); it runs
 * to today + 30. Days are computed in the site's local timezone and recomputed in bounded chunks.
 */

export interface OccupancyBackfillSummary {
  apply: boolean;
  professionals: number;
  daysPlanned: number; // (staff, day) pairs the plan covers — identical for dry-run and apply
  daysComputed: number; // actually recomputed (0 on a dry run)
}

const CHUNK_DAYS = 120;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function backfillOccupancy(opts: { apply: boolean; tenantId?: string; clientId?: string }): Promise<OccupancyBackfillSummary> {
  const targets = await listBookableStaffTargets({ tenantId: opts.tenantId, clientId: opts.clientId });
  const now = new Date();
  let daysPlanned = 0;
  let daysComputed = 0;

  for (const t of targets) {
    const today = localDayKey(now, t.timeZone);
    const earliest = await earliestAppointmentForStaff(t.tenantId, t.clientId, t.staffId);
    // Start at the first-ever booking, but never later than the live past window (so a fresh
    // professional still gets the [−35, +30] range seeded).
    const windowStart = shiftDay(today, -OCCUPANCY_PAST_DAYS);
    const firstBookingDay = earliest ? localDayKey(earliest, t.timeZone) : windowStart;
    const startDay = firstBookingDay < windowStart ? firstBookingDay : windowStart;
    const endDay = shiftDay(today, OCCUPANCY_FUTURE_DAYS);

    const days = enumerateLocalDays(startDay, endDay, t.timeZone);
    daysPlanned += days.length;
    if (opts.apply) {
      for (const slice of chunk(days, CHUNK_DAYS)) {
        await recomputeStaffDays(t.tenantId, t.clientId, t.siteId, t.staffId, slice);
        daysComputed += slice.length;
      }
    }
  }
  return { apply: opts.apply, professionals: targets.length, daysPlanned, daysComputed };
}

/** Shift a "YYYY-MM-DD" by whole days using UTC-noon arithmetic (calendar-correct; the exact tz is
 *  irrelevant because we only need a calendar offset, then re-read the Y-M-D). */
function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const shifted = new Date(base.getTime() + delta * 24 * 3600 * 1000);
  const p = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
  return p;
}
