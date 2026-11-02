import { query } from '../../client.js';

/**
 * JP-8 §2 — the occupancy READ queries over the rollup: per-professional totals for a day/week/month
 * window (the screen's main table + the site total it sums), a per-period series (the small trend),
 * and "horas libres" for the next 7 days. All take site-local "YYYY-MM-DD" bounds (inclusive) and
 * are money-agnostic here — the caller decides whether to expose `collected_amount` (permission §4).
 * The heatmap is computed on demand (not from this rollup) — see `src/occupancy/heatmap.ts`.
 */

export interface StaffOccupancyTotals {
  staff_id: string;
  available_min: number;
  booked_min: number;
  attended_min: number;
  no_show_min: number;
  outside_hours_min: number;
  collected_amount: string;
}

/** Per-professional totals over [fromDay, toDay] (inclusive). One row per staff that has any rollup
 *  row in the window; a staff with no row is simply absent (the caller adds a zero row for a
 *  professional with no data). */
export async function occupancyTotalsByStaff(tenantId: string, clientId: string, fromDay: string, toDay: string): Promise<StaffOccupancyTotals[]> {
  const r = await query<StaffOccupancyTotals>(
    `SELECT staff_id,
            SUM(available_min)::int AS available_min,
            SUM(booked_min)::int AS booked_min,
            SUM(attended_min)::int AS attended_min,
            SUM(no_show_min)::int AS no_show_min,
            SUM(outside_hours_min)::int AS outside_hours_min,
            SUM(collected_amount)::text AS collected_amount
       FROM staff_day_occupancy
      WHERE tenant_id=$1 AND client_id=$2 AND day >= $3 AND day <= $4
      GROUP BY staff_id`,
    [tenantId, clientId, fromDay, toDay],
  );
  return r.rows;
}

export interface StaffFreeMinutes {
  staff_id: string;
  free_min: number;
}

/** "Horas libres" per professional across [fromDay, toDay] = Σ max(available − booked, 0). Intended
 *  for the next 7 days, but takes any window. */
export async function freeMinutesByStaff(tenantId: string, clientId: string, fromDay: string, toDay: string): Promise<StaffFreeMinutes[]> {
  const r = await query<StaffFreeMinutes>(
    `SELECT staff_id, SUM(GREATEST(available_min - booked_min, 0))::int AS free_min
       FROM staff_day_occupancy
      WHERE tenant_id=$1 AND client_id=$2 AND day >= $3 AND day <= $4
      GROUP BY staff_id`,
    [tenantId, clientId, fromDay, toDay],
  );
  return r.rows;
}

export type OccupancyGranularity = 'day' | 'week' | 'month';

export interface StaffBucketOccupancy {
  staff_id: string;
  bucket: string; // YYYY-MM-DD (bucket start; weeks start Monday per date_trunc)
  available_min: number;
  booked_min: number;
  attended_min: number;
}

/** Per (professional, period-bucket) totals over [fromDay, toDay] — the small trend. Weeks start
 *  Monday (Postgres `date_trunc('week', …)`); months are calendar months. */
export async function occupancySeriesByStaff(
  tenantId: string,
  clientId: string,
  fromDay: string,
  toDay: string,
  granularity: OccupancyGranularity,
): Promise<StaffBucketOccupancy[]> {
  // `granularity` is a fixed internal enum (never user text) — safe to inline into date_trunc.
  const unit = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';
  const r = await query<StaffBucketOccupancy>(
    `SELECT staff_id,
            to_char(date_trunc('${unit}', day)::date, 'YYYY-MM-DD') AS bucket,
            SUM(available_min)::int AS available_min,
            SUM(booked_min)::int AS booked_min,
            SUM(attended_min)::int AS attended_min
       FROM staff_day_occupancy
      WHERE tenant_id=$1 AND client_id=$2 AND day >= $3 AND day <= $4
      GROUP BY staff_id, bucket
      ORDER BY staff_id, bucket`,
    [tenantId, clientId, fromDay, toDay],
  );
  return r.rows;
}
