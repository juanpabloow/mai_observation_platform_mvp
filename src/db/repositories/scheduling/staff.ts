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
  opts: { siteId?: string; includeInactive?: boolean } = {},
): Promise<StaffRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  if (opts.siteId) {
    params.push(opts.siteId);
    where.push(`site_id = $${params.length}`);
  }
  if (!opts.includeInactive) where.push('active = true');
  const r = await query<StaffRow>(
    `SELECT * FROM staff WHERE ${where.join(' AND ')} ORDER BY name`,
    params,
  );
  return r.rows;
}

export async function getStaffById(tenantId: string, id: string): Promise<StaffRow | null> {
  const r = await query<StaffRow>(`SELECT * FROM staff WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ?? null;
}

/** Active staff at a site who can perform a service (joined via staff_services). */
export async function listStaffForService(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<StaffRow[]> {
  const r = await query<StaffRow>(
    `SELECT s.* FROM staff s
       JOIN staff_services ss ON ss.staff_id = s.id AND ss.active = true
      WHERE s.tenant_id = $1 AND s.site_id = $2 AND ss.service_id = $3 AND s.active = true
      ORDER BY s.id`,
    [tenantId, siteId, serviceId],
  );
  return r.rows;
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
