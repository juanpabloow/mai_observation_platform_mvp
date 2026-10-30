import { query } from '../../client.js';
import type { AppointmentStatus } from './appointments.js';

/**
 * JP-8 §1 — the data layer for the staff-occupancy rollup: the rollup upsert/delete, the recompute
 * inputs (appointments + recorded service payments, scoped and timezone-bucketed), and the dirty
 * queue (mark / claim / clear). The engine math lives in `src/occupancy/compute.ts`; this file is
 * only SQL. The §2 read queries (day/week/month, free hours, heatmap) live in `occupancyReads.ts`.
 */

/** One rollup row. Minutes are whole; `collected` is a numeric string (pg numeric). */
export interface StaffDayOccupancyRow {
  tenant_id: string;
  client_id: string;
  site_id: string;
  staff_id: string;
  day: string; // YYYY-MM-DD (site-local)
  available_min: number;
  booked_min: number;
  attended_min: number;
  no_show_min: number;
  outside_hours_min: number;
  collected_amount: string;
}

/** The subset recompute writes (the row minus identity). */
export interface OccupancyMetrics {
  availableMin: number;
  bookedMin: number;
  attendedMin: number;
  noShowMin: number;
  outsideHoursMin: number;
  collectedAmount: string;
}

export interface DirtyEntry {
  tenantId: string;
  clientId: string;
  siteId: string;
  staffId: string;
  day: string; // YYYY-MM-DD (site-local)
}

/** Upsert one (staff, day) rollup row. Idempotent — recompute always overwrites. */
export async function upsertStaffDayOccupancy(key: DirtyEntry, m: OccupancyMetrics): Promise<void> {
  await query(
    `INSERT INTO staff_day_occupancy
       (tenant_id, client_id, site_id, staff_id, day,
        available_min, booked_min, attended_min, no_show_min, outside_hours_min, collected_amount, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
     ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET
       available_min = EXCLUDED.available_min,
       booked_min = EXCLUDED.booked_min,
       attended_min = EXCLUDED.attended_min,
       no_show_min = EXCLUDED.no_show_min,
       outside_hours_min = EXCLUDED.outside_hours_min,
       collected_amount = EXCLUDED.collected_amount,
       updated_at = now()`,
    [key.tenantId, key.clientId, key.siteId, key.staffId, key.day,
      m.availableMin, m.bookedMin, m.attendedMin, m.noShowMin, m.outsideHoursMin, m.collectedAmount],
  );
}

/** Remove a (staff, day) rollup row — used when a recompute finds the day fully empty (no capacity,
 *  no appointments, no money), so the table never carries meaningless all-zero rows. */
export async function deleteStaffDayOccupancy(key: DirtyEntry): Promise<void> {
  await query(
    `DELETE FROM staff_day_occupancy WHERE tenant_id=$1 AND client_id=$2 AND site_id=$3 AND staff_id=$4 AND day=$5`,
    [key.tenantId, key.clientId, key.siteId, key.staffId, key.day],
  );
}

export interface OccupancyApptRow {
  start_at: Date;
  service_end_at: Date;
  status: AppointmentStatus;
}

/** The staff's non-cancelled appointments overlapping [from, to) — the occupied-minutes source.
 *  Cancelled never counts (it reserved nothing), so it is excluded here. */
export async function listAppointmentsForOccupancy(
  tenantId: string,
  clientId: string,
  staffId: string,
  from: Date,
  to: Date,
): Promise<OccupancyApptRow[]> {
  const r = await query<OccupancyApptRow>(
    `SELECT start_at, service_end_at, status
       FROM appointments
      WHERE tenant_id=$1 AND client_id=$2 AND staff_id=$3 AND status <> 'cancelled'
        AND start_at >= $4 AND start_at < $5
      ORDER BY start_at`,
    [tenantId, clientId, staffId, from, to],
  );
  return r.rows;
}

/** Recorded SERVICE revenue attributed to this staff per site-local day in [from, to). Product
 *  lines and commission are excluded: we sum `payment_lines.line_total` for `kind='service'` on
 *  this staff's lines of RECORDED payments, bucketed by the appointment's local day. */
export async function collectedServiceByDay(
  tenantId: string,
  clientId: string,
  staffId: string,
  from: Date,
  to: Date,
  timeZone: string,
): Promise<Map<string, string>> {
  const r = await query<{ day: string; collected: string }>(
    `SELECT to_char((a.start_at AT TIME ZONE $6)::date, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(pl.line_total), 0)::text AS collected
       FROM payment_lines pl
       JOIN payments p ON p.id = pl.payment_id AND p.tenant_id = pl.tenant_id
       JOIN appointments a ON a.id = p.appointment_id AND a.tenant_id = p.tenant_id
      WHERE pl.tenant_id=$1 AND pl.client_id=$2 AND pl.kind='service' AND pl.staff_id=$3
        AND p.status='recorded'
        AND a.start_at >= $4 AND a.start_at < $5
      GROUP BY 1`,
    [tenantId, clientId, staffId, from, to, timeZone],
  );
  return new Map(r.rows.map((x) => [x.day, x.collected]));
}

// ── Dirty queue ───────────────────────────────────────────────────────────────────

/** Mark (staff, day) pairs dirty. `enqueued_at` is bumped on every re-mark so a mark that lands
 *  while a recompute is in flight is NOT lost (the drainer clears only rows whose `enqueued_at` it
 *  saw). A no-op for an empty list. Scoped writes only; never throws for a duplicate. */
export async function markOccupancyDirty(entries: DirtyEntry[]): Promise<void> {
  if (entries.length === 0) return;
  // Build a single multi-row INSERT (bounded batches keep the parameter count sane).
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    slice.forEach((e, j) => {
      const b = j * 5;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5}, now())`);
      params.push(e.tenantId, e.clientId, e.siteId, e.staffId, e.day);
    });
    await query(
      `INSERT INTO occupancy_dirty_days (tenant_id, client_id, site_id, staff_id, day, enqueued_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET enqueued_at = now()`,
      params,
    );
  }
}

/** Mark the (staff, local day) of one appointment dirty. The local day is derived IN SQL from the
 *  site's timezone, so callers never need the tz. Used for every appointment + payment write. */
export async function markDirtyForAppointment(tenantId: string, clientId: string, siteId: string, staffId: string, startAt: Date): Promise<void> {
  await query(
    `INSERT INTO occupancy_dirty_days (tenant_id, client_id, site_id, staff_id, day, enqueued_at)
     SELECT $1, $2, $3, $4, (($5::timestamptz) AT TIME ZONE si.timezone)::date, now()
       FROM sites si WHERE si.tenant_id = $1 AND si.id = $3
     ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET enqueued_at = now()`,
    [tenantId, clientId, siteId, staffId, startAt],
  );
}

const WINDOW_SELECT = `
  SELECT st.tenant_id, si.client_id, si.id, st.id, gs.d::date, now()
    FROM staff st
    JOIN sites si ON si.id = st.site_id AND si.tenant_id = st.tenant_id
    JOIN clients c ON c.id = si.client_id AND c.tenant_id = si.tenant_id
   CROSS JOIN LATERAL generate_series(
     (now() AT TIME ZONE si.timezone)::date - ($PAST::int),
     (now() AT TIME ZONE si.timezone)::date + ($FUTURE::int),
     interval '1 day') AS gs(d)`;

/** Mark a rolling window [now−past, now+future] dirty for ONE professional (e.g. their weekly hours
 *  changed). Days are computed per the site's own timezone. */
export async function markDirtyWindowForStaff(tenantId: string, staffId: string, pastDays: number, futureDays: number): Promise<void> {
  await query(
    `INSERT INTO occupancy_dirty_days (tenant_id, client_id, site_id, staff_id, day, enqueued_at)
     ${WINDOW_SELECT.replace('$PAST', '$2').replace('$FUTURE', '$3')}
      WHERE st.tenant_id = $1 AND st.id = $4 AND si.active AND c.is_default = false
     ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET enqueued_at = now()`,
    [tenantId, pastDays, futureDays, staffId],
  );
}

/** Mark the rolling window dirty for every bookable professional of a SITE (e.g. the site's opening
 *  hours or a site-wide break changed). */
export async function markDirtyWindowForSite(tenantId: string, siteId: string, pastDays: number, futureDays: number): Promise<void> {
  await query(
    `INSERT INTO occupancy_dirty_days (tenant_id, client_id, site_id, staff_id, day, enqueued_at)
     ${WINDOW_SELECT.replace('$PAST', '$2').replace('$FUTURE', '$3')}
      WHERE st.tenant_id = $1 AND si.id = $4 AND si.active AND st.active AND st.takes_bookings AND c.is_default = false
     ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET enqueued_at = now()`,
    [tenantId, pastDays, futureDays, siteId],
  );
}

/** Mark the rolling window dirty for EVERY bookable professional of every real client — the nightly
 *  pass, so hours/break/closure edits and the passage of time are always reconciled. */
export async function markDirtyWindowAll(pastDays: number, futureDays: number): Promise<void> {
  await query(
    `INSERT INTO occupancy_dirty_days (tenant_id, client_id, site_id, staff_id, day, enqueued_at)
     ${WINDOW_SELECT.replace('$PAST', '$1').replace('$FUTURE', '$2')}
      WHERE st.active AND st.takes_bookings AND si.active AND c.is_default = false
     ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET enqueued_at = now()`,
    [pastDays, futureDays],
  );
}

/** Mark every local day a time-off / closure spans. A staff-specific exception marks that staff
 *  (even if deactivated — so their history stays correct); a site-wide one (staffId null) marks
 *  every bookable professional of the site. The half-open end is clamped back one microsecond so an
 *  exception ending exactly at local midnight does not mark the following day. */
export async function markDirtyExceptionRange(tenantId: string, siteId: string, staffId: string | null, startsAt: Date, endsAt: Date): Promise<void> {
  await query(
    `INSERT INTO occupancy_dirty_days (tenant_id, client_id, site_id, staff_id, day, enqueued_at)
     SELECT st.tenant_id, si.client_id, si.id, st.id, gs.d::date, now()
       FROM staff st
       JOIN sites si ON si.id = st.site_id AND si.tenant_id = st.tenant_id
      CROSS JOIN LATERAL generate_series(
        (($4::timestamptz) AT TIME ZONE si.timezone)::date,
        (($5::timestamptz - interval '1 microsecond') AT TIME ZONE si.timezone)::date,
        interval '1 day') AS gs(d)
      WHERE st.tenant_id = $1 AND si.id = $2
        AND (($3::uuid IS NOT NULL AND st.id = $3) OR ($3::uuid IS NULL AND st.active AND st.takes_bookings))
     ON CONFLICT (tenant_id, client_id, site_id, staff_id, day) DO UPDATE SET enqueued_at = now()`,
    [tenantId, siteId, staffId, startsAt, endsAt],
  );
}

export interface ClaimedDirtyRow extends DirtyEntry {
  /** Microsecond-precise UTC timestamp string (so the clear-guard round-trips exactly — a JS Date
   *  would truncate Postgres's microsecond `now()` and never re-match on delete). */
  enqueuedAt: string;
}

const ENQUEUED_TEXT = `to_char(enqueued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Claim up to `limit` dirty rows, oldest first. They stay in the table until `clearDirty` removes
 *  them after a successful recompute, so a crash mid-recompute just reprocesses them next pass. */
export async function claimDirtyBatch(limit: number): Promise<ClaimedDirtyRow[]> {
  const r = await query<{ tenant_id: string; client_id: string; site_id: string; staff_id: string; day: string; enqueued_at: string }>(
    `SELECT tenant_id, client_id, site_id, staff_id, to_char(day, 'YYYY-MM-DD') AS day, ${ENQUEUED_TEXT} AS enqueued_at
       FROM occupancy_dirty_days
      ORDER BY enqueued_at ASC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((x) => ({ tenantId: x.tenant_id, clientId: x.client_id, siteId: x.site_id, staffId: x.staff_id, day: x.day, enqueuedAt: x.enqueued_at }));
}

/** Remove a processed dirty row ONLY if it has not been re-marked since it was claimed (its
 *  `enqueued_at` still matches). A row re-marked mid-recompute keeps a newer `enqueued_at` and
 *  survives to be recomputed again. */
export async function clearDirty(row: ClaimedDirtyRow): Promise<void> {
  await query(
    `DELETE FROM occupancy_dirty_days
      WHERE tenant_id=$1 AND client_id=$2 AND site_id=$3 AND staff_id=$4 AND day=$5 AND ${ENQUEUED_TEXT} = $6`,
    [row.tenantId, row.clientId, row.siteId, row.staffId, row.day, row.enqueuedAt],
  );
}

export async function dirtyCount(): Promise<number> {
  const r = await query<{ n: string }>(`SELECT count(*)::text AS n FROM occupancy_dirty_days`);
  return Number(r.rows[0]?.n ?? 0);
}

// ── Staff targets (for the nightly rolling-window pass and the backfill) ─────────────

export interface OccupancyStaffTarget {
  tenantId: string;
  clientId: string;
  siteId: string;
  staffId: string;
  timeZone: string;
}

/** The earliest non-cancelled appointment start for a professional, or null if they have none.
 *  The backfill walks history from here. */
export async function earliestAppointmentForStaff(tenantId: string, clientId: string, staffId: string): Promise<Date | null> {
  const r = await query<{ first: Date | null }>(
    `SELECT MIN(start_at) AS first FROM appointments
      WHERE tenant_id=$1 AND client_id=$2 AND staff_id=$3 AND status <> 'cancelled'`,
    [tenantId, clientId, staffId],
  );
  return r.rows[0]?.first ?? null;
}

/** Every bookable professional (active + takes_bookings) of a real client, with its site timezone.
 *  Optional tenant / client scoping for the backfill. Deactivated staff are excluded going forward
 *  but keep their history (their existing rows are never purged). */
export async function listBookableStaffTargets(opts: { tenantId?: string; clientId?: string } = {}): Promise<OccupancyStaffTarget[]> {
  const params: unknown[] = [];
  const where: string[] = ['st.active = true', 'st.takes_bookings = true', 'si.active = true', 'c.is_default = false'];
  if (opts.tenantId) { params.push(opts.tenantId); where.push(`st.tenant_id = $${params.length}`); }
  if (opts.clientId) { params.push(opts.clientId); where.push(`si.client_id = $${params.length}`); }
  const r = await query<{ tenant_id: string; client_id: string; site_id: string; staff_id: string; timezone: string }>(
    `SELECT st.tenant_id, si.client_id, si.id AS site_id, st.id AS staff_id, si.timezone
       FROM staff st
       JOIN sites si ON si.id = st.site_id AND si.tenant_id = st.tenant_id
       JOIN clients c ON c.id = si.client_id AND c.tenant_id = si.tenant_id
      WHERE ${where.join(' AND ')}
      ORDER BY st.tenant_id, si.client_id, st.id`,
    params,
  );
  return r.rows.map((x) => ({ tenantId: x.tenant_id, clientId: x.client_id, siteId: x.site_id, staffId: x.staff_id, timeZone: x.timezone }));
}
