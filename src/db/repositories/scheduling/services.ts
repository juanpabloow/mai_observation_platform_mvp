import { query, firstRowOrThrow } from '../../client.js';

/**
 * Services repository — the tenant-level service catalogue plus the two explicit
 * enablement joins (site_services, staff_services) with optional per-site /
 * per-staff duration & price overrides. Tenant-scoped throughout.
 */

export interface ServiceRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price: string | null; // numeric comes back as string from pg
  buffer_before_min: number;
  buffer_after_min: number;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listServices(tenantId: string, includeInactive = false): Promise<ServiceRow[]> {
  const r = await query<ServiceRow>(
    `SELECT * FROM services WHERE tenant_id = $1 ${includeInactive ? '' : 'AND active = true'} ORDER BY name`,
    [tenantId],
  );
  return r.rows;
}

export async function getServiceById(tenantId: string, id: string): Promise<ServiceRow | null> {
  const r = await query<ServiceRow>(`SELECT * FROM services WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ?? null;
}

/** Services enabled at a site (join site_services), with effective duration/price
 * after any site override. Used by the availability + public booking flows. */
export interface SiteServiceRow extends ServiceRow {
  site_service_id: string;
  duration_override_min: number | null;
  price_override: string | null;
  effective_duration_min: number;
  effective_price: string | null;
}

export async function listServicesForSite(tenantId: string, siteId: string): Promise<SiteServiceRow[]> {
  // Hardened: the service is reachable ONLY through a VALID site — the site must
  // exist, be active and belong to the tenant; site_services must be same-tenant
  // and active; the service same-tenant and active. A cross-tenant or inconsistent
  // row yields nothing (fails closed) — services stays a tenant catalogue but can
  // never be used at a site it isn't properly enabled for.
  const r = await query<SiteServiceRow>(
    `SELECT s.*, ss.id AS site_service_id, ss.duration_override_min, ss.price_override,
            COALESCE(ss.duration_override_min, s.duration_min) AS effective_duration_min,
            COALESCE(ss.price_override, s.price) AS effective_price
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.active = true
       JOIN services s
         ON s.id = ss.service_id AND s.tenant_id = si.tenant_id AND s.active = true
      WHERE si.id = $2 AND si.tenant_id = $1 AND si.active = true
      ORDER BY s.name`,
    [tenantId, siteId],
  );
  return r.rows;
}

export interface CreateServiceInput {
  tenantId: string;
  name: string;
  description?: string | null;
  durationMin: number;
  price?: number | null;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
}

export async function createService(input: CreateServiceInput): Promise<ServiceRow> {
  const r = await query<ServiceRow>(
    `INSERT INTO services (tenant_id, name, description, duration_min, price, buffer_before_min, buffer_after_min)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.tenantId,
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
}

export async function updateService(tenantId: string, id: string, patch: UpdateServiceInput): Promise<ServiceRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId];
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
  if (sets.length === 0) return getServiceById(tenantId, id);
  sets.push('updated_at = now()');
  const r = await query<ServiceRow>(
    `UPDATE services SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function deactivateService(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE services SET active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND active = true`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── site_services ────────────────────────────────────────────────────────────

/** Enable (upsert) a service at a site. Validates both belong to the tenant. */
export async function setSiteService(
  tenantId: string,
  siteId: string,
  serviceId: string,
  opts: { active?: boolean; durationOverrideMin?: number | null; priceOverride?: number | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO site_services (tenant_id, site_id, service_id, active, duration_override_min, price_override)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = $2 AND tenant_id = $1)
          AND EXISTS (SELECT 1 FROM services WHERE id = $3 AND tenant_id = $1)
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

export async function setStaffService(
  tenantId: string,
  staffId: string,
  serviceId: string,
  opts: { active?: boolean; durationOverrideMin?: number | null; priceOverride?: number | null } = {},
): Promise<void> {
  await query(
    `INSERT INTO staff_services (tenant_id, staff_id, service_id, active, duration_override_min, price_override)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE EXISTS (SELECT 1 FROM staff WHERE id = $2 AND tenant_id = $1)
          AND EXISTS (SELECT 1 FROM services WHERE id = $3 AND tenant_id = $1)
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
