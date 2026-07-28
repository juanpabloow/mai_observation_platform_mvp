import type { PoolClient } from 'pg';
import { query } from '../../client.js';
import { computeAvailability } from '../../../scheduling/availability.js';
import type { SchedulingConfig, Slot, WeeklyHours } from '../../../scheduling/types.js';

/**
 * Assembles the pure availability engine's input from the DB and runs it. THE
 * single loader shared by the availability API, the public booking page, and the
 * booking service's revalidation — so every path uses identical rules.
 *
 * PER-STAFF DURATION: each staff's effective service duration is
 *   COALESCE(staff_services.duration_override_min, site_services.duration_override_min,
 *            services.duration_min)
 * so two barbers can offer the same service at different durations — the engine
 * reshapes only that staff's slots. Buffers are service-level (or the site
 * defaults when the service leaves them at 0) and apply to every staff.
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
  site: { id: string; tenant_id: string; client_id: string; timezone: string; slug: string; name: string };
  /** Buffers applied to every staff (service-level / site defaults). */
  buffers: { before_min: number; after_min: number };
  slots: Slot[];
}

interface SiteConfigRow {
  id: string;
  tenant_id: string;
  client_id: string;
  slug: string;
  name: string;
  timezone: string;
  opening_hours: WeeklyHours;
  scheduling_config: SchedulingConfig;
  base_duration_min: number;
  site_duration_override_min: number | null;
  buffer_before_min: number;
  buffer_after_min: number;
}

/** Resolve the site (incl. client) + the service's base timing at that site. */
export async function resolveSiteService(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<SiteConfigRow | null> {
  const r = await query<SiteConfigRow>(
    `SELECT si.id, si.tenant_id, si.client_id, si.slug, si.name, si.timezone,
            si.opening_hours, si.scheduling_config,
            sv.duration_min AS base_duration_min,
            ss.duration_override_min AS site_duration_override_min,
            sv.buffer_before_min, sv.buffer_after_min
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
      WHERE si.tenant_id = $1 AND si.id = $2 AND sv.id = $3 AND si.active = true`,
    [tenantId, siteId, serviceId],
  );
  return r.rows[0] ?? null;
}

function siteBuffers(row: SiteConfigRow): { before_min: number; after_min: number } {
  const cfg = row.scheduling_config;
  return {
    before_min: row.buffer_before_min > 0 ? row.buffer_before_min : cfg.default_buffer_before_min,
    after_min: row.buffer_after_min > 0 ? row.buffer_after_min : cfg.default_buffer_after_min,
  };
}

/** The price to snapshot for a concrete (staff, site, service): staff override →
 * site override → service base. Returns a numeric string or null. */
export async function resolveEffectivePrice(
  tenantId: string,
  siteId: string,
  serviceId: string,
  staffId: string,
): Promise<string | null> {
  // Hardened: the effective price is computed ONLY over a fully consistent, active
  // chain (site → site_service → service, and staff → staff_service, all same-tenant
  // and active). Overrides are COALESCEd on top. An inconsistent/foreign chain
  // yields no row → null (fail closed); valid bookings always have the chain (the
  // slot already passed availability), so the price is correct.
  const r = await query<{ price: string | null }>(
    `SELECT COALESCE(sts.price_override, ss.price_override, sv.price) AS price
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.service_id = $3 AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
       JOIN staff st
         ON st.id = $4 AND st.site_id = si.id AND st.tenant_id = si.tenant_id AND st.active = true
       JOIN staff_services sts
         ON sts.staff_id = st.id AND sts.service_id = sv.id AND sts.tenant_id = si.tenant_id AND sts.active = true
      WHERE si.id = $2 AND si.tenant_id = $1 AND si.active = true`,
    [tenantId, siteId, serviceId, staffId],
  );
  return r.rows[0]?.price ?? null;
}

/** Full availability computation for a request window. */
export async function loadAvailability(params: LoadAvailabilityParams): Promise<AvailabilityResult | null> {
  const site = await resolveSiteService(params.tenantId, params.siteId, params.serviceId);
  if (!site) return null;
  const buffers = siteBuffers(site);

  // Candidate staff (+ their per-staff duration override). Specific staff if
  // requested and qualified, else all active qualified staff at the site.
  const staffParams: unknown[] = [params.tenantId, params.siteId, params.serviceId];
  let staffWhere = 's.tenant_id = $1 AND s.site_id = $2 AND s.active = true';
  if (params.staffId) {
    staffParams.push(params.staffId);
    staffWhere += ` AND s.id = $${staffParams.length}`;
  }
  // staff_services joined with explicit tenant consistency (ss.tenant_id = s.tenant_id)
  // so a cross-tenant staff_services row can never qualify a barber for the service.
  const staffRows = await query<{ id: string; working_hours: WeeklyHours; staff_duration_override_min: number | null }>(
    `SELECT s.id, s.working_hours, ss.duration_override_min AS staff_duration_override_min
       FROM staff s
       JOIN staff_services ss
         ON ss.staff_id = s.id AND ss.tenant_id = s.tenant_id AND ss.service_id = $3 AND ss.active = true
      WHERE ${staffWhere}
      ORDER BY s.id`,
    staffParams,
  );
  const resultSite = {
    id: site.id,
    tenant_id: site.tenant_id,
    client_id: site.client_id,
    timezone: site.timezone,
    slug: site.slug,
    name: site.name,
  };
  if (staffRows.rows.length === 0) return { site: resultSite, buffers, slots: [] };
  const staffIds = staffRows.rows.map((s) => s.id);

  const busyRows = await query<{ staff_id: string; blocked_from: Date; blocked_until: Date }>(
    `SELECT staff_id, blocked_from, blocked_until
       FROM appointments
      WHERE tenant_id = $1 AND site_id = $2 AND staff_id = ANY($3::uuid[])
        AND status IN ('scheduled','confirmed')
        AND blocked_until > $4 AND blocked_from < $5`,
    [params.tenantId, params.siteId, staffIds, params.from, params.to],
  );

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
    timing: {
      duration_min: s.staff_duration_override_min ?? site.site_duration_override_min ?? site.base_duration_min,
      buffer_before_min: buffers.before_min,
      buffer_after_min: buffers.after_min,
    },
    busy: busyRows.rows.filter((b) => b.staff_id === s.id).map((b) => ({ from: b.blocked_from, until: b.blocked_until })),
    exceptions: excRows.rows.filter((e) => e.staff_id === s.id).map((e) => ({ from: e.starts_at, until: e.ends_at })),
  }));

  const slots = computeAvailability({
    site: {
      id: site.id,
      timezone: site.timezone,
      opening_hours: site.opening_hours,
      scheduling_config: site.scheduling_config,
    },
    staff,
    siteExceptions,
    from: params.from,
    to: params.to,
    now: params.now,
  });

  return { site: resultSite, buffers, slots };
}

/** Whether a specific (start, staff) is currently bookable — used by the booking
 * service to REVALIDATE just before insert. Returns the chosen staff's service
 * window (end) so the caller can snapshot the exact duration. */
export async function isSlotAvailable(
  params: { tenantId: string; siteId: string; serviceId: string; staffId: string; startAt: Date; now: Date },
  client?: PoolClient,
): Promise<{ available: boolean; serviceEndAt: Date | null; buffers: { before_min: number; after_min: number } | null }> {
  void client; // availability reads use the pool; the insert (next step) holds the txn
  const windowStart = new Date(params.startAt.getTime() - 60 * 60 * 1000);
  // 24h upper bound (was 6h): availability.ts filters a candidate when
  // `startAt + serviceDuration > windowEnd`, so a too-narrow window silently makes a
  // long service un-reschedulable (same class of bug as createAppointment's window).
  // Any single-day service fits within 24h; the free interval is the real gate.
  const windowEnd = new Date(params.startAt.getTime() + 24 * 60 * 60 * 1000);
  const avail = await loadAvailability({
    tenantId: params.tenantId,
    siteId: params.siteId,
    serviceId: params.serviceId,
    staffId: params.staffId,
    from: windowStart,
    to: windowEnd,
    now: params.now,
  });
  if (!avail) return { available: false, serviceEndAt: null, buffers: null };
  const slot = avail.slots.find((s) => s.start_at.getTime() === params.startAt.getTime());
  const candidate = slot?.candidates.find((c) => c.staff_id === params.staffId);
  return { available: Boolean(candidate), serviceEndAt: candidate?.service_end_at ?? null, buffers: avail.buffers };
}
