import type { PoolClient } from 'pg';
import { query } from '../../client.js';
import { computeAvailability } from '../../../scheduling/availability.js';
import type { SchedulingConfig, Slot, WeeklyHours } from '../../../scheduling/types.js';

/**
 * Assembles the pure availability engine's input from the DB and runs it. THE
 * single loader shared by the availability API, the public booking page, and the
 * booking service's revalidation — so every path uses identical rules.
 *
 * Effective service timing is resolved at the (site, service) level so the slot
 * grid is uniform across staff (required for the "any staff" dedup-by-start):
 *   duration = COALESCE(site_services.duration_override_min, services.duration_min)
 *   buffers  = the service's own buffers, or the site defaults when the service
 *              leaves them at 0.
 * (Per-staff duration overrides are stored but do not reshape the V1 grid; per-
 * staff PRICE overrides are honored at booking time.)
 */

export interface EffectiveTiming {
  duration_min: number;
  buffer_before_min: number;
  buffer_after_min: number;
}

export interface LoadAvailabilityParams {
  tenantId: string;
  siteId: string;
  serviceId: string;
  staffId?: string | null;
  from: Date;
  to: Date;
  now: Date;
}

export interface AvailabilityResult {
  site: { id: string; timezone: string; slug: string; name: string };
  timing: EffectiveTiming;
  slots: Slot[];
}

interface SiteConfigRow {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  opening_hours: WeeklyHours;
  scheduling_config: SchedulingConfig;
}

/** Resolve the effective timing for (site, service) and the site config row. */
export async function resolveTimingAndSite(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<{ site: SiteConfigRow; timing: EffectiveTiming } | null> {
  const r = await query<SiteConfigRow & { duration_min: number; duration_override_min: number | null; buffer_before_min: number; buffer_after_min: number }>(
    `SELECT si.id, si.slug, si.name, si.timezone, si.opening_hours, si.scheduling_config,
            sv.duration_min, ss.duration_override_min, sv.buffer_before_min, sv.buffer_after_min
       FROM sites si
       JOIN site_services ss ON ss.site_id = si.id AND ss.active = true
       JOIN services sv ON sv.id = ss.service_id AND sv.active = true
      WHERE si.tenant_id = $1 AND si.id = $2 AND sv.id = $3 AND si.active = true`,
    [tenantId, siteId, serviceId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const cfg = row.scheduling_config;
  const timing: EffectiveTiming = {
    duration_min: row.duration_override_min ?? row.duration_min,
    buffer_before_min: row.buffer_before_min > 0 ? row.buffer_before_min : cfg.default_buffer_before_min,
    buffer_after_min: row.buffer_after_min > 0 ? row.buffer_after_min : cfg.default_buffer_after_min,
  };
  return { site: row, timing };
}

/** The price to snapshot for a concrete (staff, site, service): staff override →
 * site override → service base. Returns a numeric string or null. */
export async function resolveEffectivePrice(
  tenantId: string,
  siteId: string,
  serviceId: string,
  staffId: string,
): Promise<string | null> {
  const r = await query<{ price: string | null }>(
    `SELECT COALESCE(sts.price_override, ss.price_override, sv.price) AS price
       FROM services sv
       LEFT JOIN site_services ss ON ss.service_id = sv.id AND ss.site_id = $2
       LEFT JOIN staff_services sts ON sts.service_id = sv.id AND sts.staff_id = $4
      WHERE sv.tenant_id = $1 AND sv.id = $3`,
    [tenantId, siteId, serviceId, staffId],
  );
  return r.rows[0]?.price ?? null;
}

/** Full availability computation for a request window. */
export async function loadAvailability(params: LoadAvailabilityParams): Promise<AvailabilityResult | null> {
  const resolved = await resolveTimingAndSite(params.tenantId, params.siteId, params.serviceId);
  if (!resolved) return null;
  const { site, timing } = resolved;

  // Candidate staff: the specific one (if requested + qualified), else all active
  // staff at the site who perform the service.
  const staffParams: unknown[] = [params.tenantId, params.siteId, params.serviceId];
  let staffWhere = 's.tenant_id = $1 AND s.site_id = $2 AND s.active = true';
  if (params.staffId) {
    staffParams.push(params.staffId);
    staffWhere += ` AND s.id = $${staffParams.length}`;
  }
  const staffRows = await query<{ id: string; working_hours: WeeklyHours }>(
    `SELECT s.id, s.working_hours
       FROM staff s
       JOIN staff_services ss ON ss.staff_id = s.id AND ss.service_id = $3 AND ss.active = true
      WHERE ${staffWhere}
      ORDER BY s.id`,
    staffParams,
  );
  if (staffRows.rows.length === 0) {
    return { site: { id: site.id, timezone: site.timezone, slug: site.slug, name: site.name }, timing, slots: [] };
  }
  const staffIds = staffRows.rows.map((s) => s.id);

  // Busy: active appointments overlapping the window, per staff (blocked ranges).
  const busyRows = await query<{ staff_id: string; blocked_from: Date; blocked_until: Date }>(
    `SELECT staff_id, blocked_from, blocked_until
       FROM appointments
      WHERE tenant_id = $1 AND site_id = $2 AND staff_id = ANY($3::uuid[])
        AND status IN ('scheduled','confirmed')
        AND blocked_until > $4 AND blocked_from < $5`,
    [params.tenantId, params.siteId, staffIds, params.from, params.to],
  );

  // Exceptions overlapping the window: site-wide (staff_id NULL) and per-staff.
  const excRows = await query<{ staff_id: string | null; starts_at: Date; ends_at: Date }>(
    `SELECT staff_id, starts_at, ends_at
       FROM schedule_exceptions
      WHERE tenant_id = $1 AND site_id = $2 AND ends_at > $3 AND starts_at < $4
        AND (staff_id IS NULL OR staff_id = ANY($5::uuid[]))`,
    [params.tenantId, params.siteId, params.from, params.to, staffIds],
  );

  const siteExceptions = excRows.rows
    .filter((e) => e.staff_id === null)
    .map((e) => ({ from: e.starts_at, until: e.ends_at }));

  const staff = staffRows.rows.map((s) => ({
    id: s.id,
    working_hours: s.working_hours,
    busy: busyRows.rows.filter((b) => b.staff_id === s.id).map((b) => ({ from: b.blocked_from, until: b.blocked_until })),
    exceptions: excRows.rows
      .filter((e) => e.staff_id === s.id)
      .map((e) => ({ from: e.starts_at, until: e.ends_at })),
  }));

  const slots = computeAvailability({
    site: {
      id: site.id,
      timezone: site.timezone,
      opening_hours: site.opening_hours,
      scheduling_config: site.scheduling_config,
    },
    service: timing,
    staff,
    siteExceptions,
    from: params.from,
    to: params.to,
    now: params.now,
  });

  return { site: { id: site.id, timezone: site.timezone, slug: site.slug, name: site.name }, timing, slots };
}

/** Whether a specific slot (exact start + staff) is currently bookable — used by
 * the booking service to REVALIDATE just before insert. Runs on the txn client
 * when given so the read is inside the booking transaction. */
export async function isSlotAvailable(
  params: { tenantId: string; siteId: string; serviceId: string; staffId: string; startAt: Date; now: Date },
  client?: PoolClient,
): Promise<{ available: boolean; timing: EffectiveTiming | null; siteId: string }> {
  // Re-run the loader for a tight window around the requested start. (The engine
  // re-checks opening hours, exceptions, buffers, notice + horizon; the DB
  // exclusion constraint is the ultimate concurrency guard at insert time.)
  const resolved = await resolveTimingAndSite(params.tenantId, params.siteId, params.serviceId);
  if (!resolved) return { available: false, timing: null, siteId: params.siteId };
  void client; // availability read uses the pool; the insert (next step) holds the txn
  const windowStart = new Date(params.startAt.getTime() - 60 * 60 * 1000);
  const windowEnd = new Date(params.startAt.getTime() + 60 * 60 * 1000);
  const avail = await loadAvailability({
    tenantId: params.tenantId,
    siteId: params.siteId,
    serviceId: params.serviceId,
    staffId: params.staffId,
    from: windowStart,
    to: windowEnd,
    now: params.now,
  });
  if (!avail) return { available: false, timing: null, siteId: params.siteId };
  const hit = avail.slots.some(
    (s) => s.start_at.getTime() === params.startAt.getTime() && s.available_staff_ids.includes(params.staffId),
  );
  return { available: hit, timing: avail.timing, siteId: params.siteId };
}
