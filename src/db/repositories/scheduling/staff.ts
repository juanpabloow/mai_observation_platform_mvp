import { query, firstRowOrThrow } from '../../client.js';
import type { WeeklyHours } from '../../../scheduling/types.js';

/**
 * Staff repository — agendable resources (a barber), each belonging to exactly one
 * site in V1. working_hours = {} means "inherit the site's opening hours".
 * Tenant-scoped throughout.
 */

export interface StaffRow {
  id: string;
  tenant_id: string;
  site_id: string;
  name: string;
  working_hours: WeeklyHours;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function listStaff(
  tenantId: string,
  opts: { siteId?: string; includeInactive?: boolean; clientId?: string | null } = {},
): Promise<StaffRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['s.tenant_id = $1'];
  if (opts.siteId) {
    params.push(opts.siteId);
    where.push(`s.site_id = $${params.length}`);
  }
  if (opts.clientId) {
    // Client scope flows through the site (staff belong to a site of a client).
    params.push(opts.clientId);
    where.push(`si.client_id = $${params.length}`);
  }
  if (!opts.includeInactive) where.push('s.active = true');
  const r = await query<StaffRow>(
    `SELECT s.* FROM staff s JOIN sites si ON si.id = s.site_id
      WHERE ${where.join(' AND ')} ORDER BY s.name`,
    params,
  );
  return r.rows;
}

export async function getStaffById(tenantId: string, id: string): Promise<StaffRow | null> {
  const r = await query<StaffRow>(`SELECT * FROM staff WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ?? null;
}

/** Active staff at a site who can perform a service. Hardened: requires a VALID
 * site (exists, active, in tenant), the service ENABLED at that site (site_services
 * active) and same-tenant/active, the staff belonging to that site+tenant, and an
 * active same-tenant staff_services row. Any inconsistent relation fails closed. */
export async function listStaffForService(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<StaffRow[]> {
  const r = await query<StaffRow>(
    `SELECT s.*
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.service_id = $3 AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id AND sv.active = true
       JOIN staff s
         ON s.site_id = si.id AND s.tenant_id = si.tenant_id AND s.active = true
       JOIN staff_services sts
         ON sts.staff_id = s.id AND sts.service_id = sv.id AND sts.tenant_id = si.tenant_id AND sts.active = true
      WHERE si.id = $2 AND si.tenant_id = $1 AND si.active = true
      ORDER BY s.id`,
    [tenantId, siteId, serviceId],
  );
  return r.rows;
}

/** Is `staffId` an ACTIVE staff member of this site (same tenant)? Used by the
 * machine API to 404 a staff_id filter that belongs to another site/client. */
export async function isActiveStaffOfSite(tenantId: string, siteId: string, staffId: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT true AS ok FROM staff
      WHERE id = $3 AND tenant_id = $1 AND site_id = $2 AND active = true`,
    [tenantId, siteId, staffId],
  );
  return r.rows.length > 0;
}

export interface CreateStaffInput {
  tenantId: string;
  siteId: string;
  name: string;
  workingHours?: WeeklyHours;
}

export async function createStaff(input: CreateStaffInput): Promise<StaffRow> {
  const r = await query<StaffRow>(
    `INSERT INTO staff (tenant_id, site_id, name, working_hours)
       SELECT $1, $2, $3, $4
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = $2 AND tenant_id = $1)
     RETURNING *`,
    [input.tenantId, input.siteId, input.name, JSON.stringify(input.workingHours ?? {})],
  );
  if (!r.rows[0]) throw new Error('createStaff: site not found for tenant');
  return firstRowOrThrow(r, 'createStaff');
}

export interface UpdateStaffInput {
  name?: string;
  workingHours?: WeeklyHours;
  active?: boolean;
  siteId?: string;
}

export async function updateStaff(tenantId: string, id: string, patch: UpdateStaffInput): Promise<StaffRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.workingHours !== undefined) add('working_hours', JSON.stringify(patch.workingHours));
  if (patch.active !== undefined) add('active', patch.active);
  if (patch.siteId !== undefined) add('site_id', patch.siteId);
  if (sets.length === 0) return getStaffById(tenantId, id);
  sets.push('updated_at = now()');
  const r = await query<StaffRow>(
    `UPDATE staff SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

export async function deactivateStaff(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE staff SET active = false, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND active = true`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The inverse of deactivateStaff — reactivation restores availability + new bookings
 * for this staff member with no data migration and no side effects. Returns true if a
 * staff member was reactivated (false if not found / already active). */
export async function reactivateStaff(tenantId: string, id: string): Promise<boolean> {
  const r = await query(
    `UPDATE staff SET active = true, updated_at = now() WHERE id = $1 AND tenant_id = $2 AND active = false`,
    [id, tenantId],
  );
  return (r.rowCount ?? 0) > 0;
}
