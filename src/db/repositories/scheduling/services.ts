import { query, firstRowOrThrow } from '../../client.js';
import { matchByName, type NameMatch } from '../../../scheduling/nameMatch.js';

/**
 * Services repository — the per-CLIENT service catalogue (tenant_id + client_id) plus
 * the two explicit enablement joins (site_services, staff_services) with optional
 * per-site / per-staff duration & price overrides.
 *
 * ISOLATION: a service belongs to exactly one (tenant, client). Every READ filters by
 * tenant_id + client_id; every WRITE that links a service to a site or staff validates
 * STRUCTURALLY (in SQL) that the service and the site/staff belong to the SAME client,
 * so a service id from another client can never be enabled at, assigned to, or booked
 * against another client's resources. Filtering by tenant alone is never enough.
 */

export interface ServiceRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price: string | null; // numeric comes back as string from pg
  buffer_before_min: number;
  buffer_after_min: number;
  active: boolean;
  /** Operator-chosen "offer this first" flag (default false). The API returns featured
   *  services ahead of the rest and can filter to only them (see listServicesForSite). */
  featured: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listServices(
  tenantId: string,
  clientId: string,
  includeInactive = false,
): Promise<ServiceRow[]> {
  const r = await query<ServiceRow>(
    `SELECT * FROM services
      WHERE tenant_id = $1 AND client_id = $2 ${includeInactive ? '' : 'AND active = true'}
      ORDER BY featured DESC, name`,
    [tenantId, clientId],
  );
  return r.rows;
}

export async function getServiceById(
  tenantId: string,
  clientId: string,
  id: string,
): Promise<ServiceRow | null> {
  const r = await query<ServiceRow>(
    `SELECT * FROM services WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/** Services enabled at a site (join site_services), with effective duration/price
 * after any site override. Used by the availability + public booking flows. The site
 * carries the client, so this is inherently client-scoped; the `s.client_id =
 * si.client_id` join is the structural guarantee (a foreign-client service enabled at
 * this site by inconsistent data would still be excluded). */
export interface SiteServiceRow extends ServiceRow {
  site_service_id: string;
  duration_override_min: number | null;
  price_override: string | null;
  effective_duration_min: number;
  effective_price: string | null;
}

export async function listServicesForSite(tenantId: string, siteId: string): Promise<SiteServiceRow[]> {
  const r = await query<SiteServiceRow>(
    `SELECT s.*, ss.id AS site_service_id, ss.duration_override_min, ss.price_override,
            COALESCE(ss.duration_override_min, s.duration_min) AS effective_duration_min,
            COALESCE(ss.price_override, s.price) AS effective_price
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.active = true
       JOIN services s
         ON s.id = ss.service_id AND s.tenant_id = si.tenant_id
        AND s.client_id = si.client_id AND s.active = true
      WHERE si.id = $2 AND si.tenant_id = $1 AND si.active = true
      ORDER BY s.featured DESC, s.name`,
    [tenantId, siteId],
  );
  return r.rows;
}

/** Resolve a service NAME (case/accent-insensitive) to its id, among the services ENABLED
 * at this site (the set an availability/booking call can actually use). Returns a
 * discriminated match so the route can emit not_found (with the valid names) or
 * ambiguous_match (with the candidates) — never a silent pick. Client scope flows through
 * the site (resolved as owned before this is called). */
export async function resolveServiceByNameAtSite(
  tenantId: string,
  siteId: string,
  name: string | null | undefined,
): Promise<NameMatch> {
  const rows = await listServicesForSite(tenantId, siteId);
  return matchByName(rows.map((r) => ({ id: r.id, name: r.name })), name);
}

/** Is a service ENABLED at a site (active site_services row), same-tenant, same-CLIENT,
 * and both site+service active? Used by the machine API to 404 a service that isn't
 * offered at the resolved site before touching the engine. */
export async function isServiceEnabledAtSite(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.service_id = $3 AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
      WHERE si.id = $2 AND si.tenant_id = $1 AND si.active = true`,
    [tenantId, siteId, serviceId],
  );
  return r.rows.length > 0;
}

export interface CreateServiceInput {
  tenantId: string;
  clientId: string;
  name: string;
  description?: string | null;
  durationMin: number;
  price?: number | null;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}

export async function createService(input: CreateServiceInput): Promise<ServiceRow> {
  const r = await query<ServiceRow>(
    `INSERT INTO services (tenant_id, client_id, name, description, duration_min, price, buffer_before_min, buffer_after_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [
      input.tenantId,
      input.clientId,
      input.name,
      input.description ?? null,
      input.durationMin,
      input.price ?? null,
      input.bufferBeforeMin ?? 0,
      input.bufferAfterMin ?? 0,
    ],
  );
  return firstRowOrThrow(r, 'createService');
}

export interface UpdateServiceInput {
  name?: string;
  description?: string | null;
  durationMin?: number;
  price?: number | null;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  active?: boolean;
  featured?: boolean;
}

export async function updateService(
  tenantId: string,
  clientId: string,
  id: string,
  patch: UpdateServiceInput,
): Promise<ServiceRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId, clientId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.description !== undefined) add('description', patch.description);
  if (patch.durationMin !== undefined) add('duration_min', patch.durationMin);
  if (patch.price !== undefined) add('price', patch.price);
  if (patch.bufferBeforeMin !== undefined) add('buffer_before_min', patch.bufferBeforeMin);
  if (patch.bufferAfterMin !== undefined) add('buffer_after_min', patch.bufferAfterMin);
  if (patch.active !== undefined) add('active', patch.active);
  if (patch.featured !== undefined) add('featured', patch.featured);
  if (sets.length === 0) return getServiceById(tenantId, clientId, id);
  sets.push('updated_at = now()');
  const r = await query<ServiceRow>(
    `UPDATE services SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function deactivateService(tenantId: string, clientId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE services SET active = false, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND active = true`,
    [id, tenantId, clientId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The inverse of deactivateService — reactivation makes the service bookable again
 * (where its site_services enablement is active) with no data migration. Returns true
 * if a service was reactivated (false if not found / already active). */
export async function reactivateService(tenantId: string, clientId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE services SET active = true, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND active = false`,
    [id, tenantId, clientId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── site_services ────────────────────────────────────────────────────────────

/** Enable (upsert) a service at a site. Validates STRUCTURALLY that the site and
 * the service belong to the SAME client (not just the same tenant): the guarded
 * INSERT ... SELECT only inserts when a same-client (site, service) pair exists. A
 * cross-client service id is a silent no-op (0 rows) — the caller sees no effect. */
export async function setSiteService(
  tenantId: string,
  siteId: string,
  serviceId: string,
  opts: { active?: boolean; durationOverrideMin?: number | null; priceOverride?: number | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO site_services (tenant_id, site_id, service_id, active, duration_override_min, price_override)
       SELECT $1, $2, $3, $4, $5, $6
        FROM sites si
        JOIN services sv ON sv.client_id = si.client_id AND sv.tenant_id = si.tenant_id
       WHERE si.id = $2 AND si.tenant_id = $1 AND sv.id = $3
     ON CONFLICT (site_id, service_id) DO UPDATE
       SET active = EXCLUDED.active,
           duration_override_min = EXCLUDED.duration_override_min,
           price_override = EXCLUDED.price_override,
           updated_at = now()`,
    [tenantId, siteId, serviceId, opts.active ?? true, opts.durationOverrideMin ?? null, opts.priceOverride ?? null],
  );
}

export async function removeSiteService(tenantId: string, siteId: string, serviceId: string): Promise<void> {
  await query(`DELETE FROM site_services WHERE tenant_id = $1 AND site_id = $2 AND service_id = $3`, [
    tenantId,
    siteId,
    serviceId,
  ]);
}

// ── staff_services ───────────────────────────────────────────────────────────

export interface StaffServiceRow {
  id: string;
  staff_id: string;
  service_id: string;
  active: boolean;
  duration_override_min: number | null;
  price_override: string | null;
}

export async function listStaffServices(tenantId: string, staffId: string): Promise<StaffServiceRow[]> {
  const r = await query<StaffServiceRow>(
    `SELECT id, staff_id, service_id, active, duration_override_min, price_override
       FROM staff_services WHERE tenant_id = $1 AND staff_id = $2`,
    [tenantId, staffId],
  );
  return r.rows;
}

/**
 * The service ids each of these staff can perform, as a MAP — one grouped query for
 * the whole roster. `listStaffServices` above is per-staff, which is an N+1 the
 * moment a screen renders a card per barber (the Staff roster does exactly that).
 */
export async function listStaffServiceIds(
  tenantId: string,
  staffIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (staffIds.length === 0) return out;
  const r = await query<{ staff_id: string; service_id: string }>(
    `SELECT staff_id, service_id
       FROM staff_services
      WHERE tenant_id = $1 AND staff_id = ANY($2::uuid[]) AND active = true`,
    [tenantId, staffIds],
  );
  for (const row of r.rows) {
    const list = out.get(row.staff_id) ?? [];
    list.push(row.service_id);
    out.set(row.staff_id, list);
  }
  return out;
}

/** Assign (upsert) a service to a staff member. Validates STRUCTURALLY that the
 * staff's SITE and the service belong to the SAME client: staff → site.client_id must
 * equal service.client_id. A cross-client service id is a silent no-op (0 rows). */
export async function setStaffService(
  tenantId: string,
  staffId: string,
  serviceId: string,
  opts: { active?: boolean; durationOverrideMin?: number | null; priceOverride?: number | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO staff_services (tenant_id, staff_id, service_id, active, duration_override_min, price_override)
       SELECT $1, $2, $3, $4, $5, $6
        FROM staff st
        JOIN sites si ON si.id = st.site_id AND si.tenant_id = st.tenant_id
        JOIN services sv ON sv.client_id = si.client_id AND sv.tenant_id = si.tenant_id
       WHERE st.id = $2 AND st.tenant_id = $1 AND sv.id = $3
     ON CONFLICT (staff_id, service_id) DO UPDATE
       SET active = EXCLUDED.active,
           duration_override_min = EXCLUDED.duration_override_min,
           price_override = EXCLUDED.price_override,
           updated_at = now()`,
    [tenantId, staffId, serviceId, opts.active ?? true, opts.durationOverrideMin ?? null, opts.priceOverride ?? null],
  );
}

export async function removeStaffService(tenantId: string, staffId: string, serviceId: string): Promise<void> {
  await query(`DELETE FROM staff_services WHERE tenant_id = $1 AND staff_id = $2 AND service_id = $3`, [
    tenantId,
    staffId,
    serviceId,
  ]);
}
