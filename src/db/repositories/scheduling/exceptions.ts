import { query, firstRowOrThrow } from '../../client.js';

/**
 * Schedule exceptions repository — blocked time. staff_id NULL blocks the whole
 * site; otherwise just that staff member. Tenant-scoped. ends_at > starts_at is
 * enforced by the DB CHECK; callers also validate before insert for a clean error.
 */

export interface ScheduleExceptionRow {
  id: string;
  tenant_id: string;
  site_id: string;
  staff_id: string | null;
  starts_at: Date;
  ends_at: Date;
  reason: string | null;
  type: string;
  created_at: Date;
  updated_at: Date;
}

export async function listExceptions(
  tenantId: string,
  opts: { siteId?: string; from?: Date; to?: Date } = {},
): Promise<ScheduleExceptionRow[]> {
  const params: unknown[] = [tenantId];
  const where = ['tenant_id = $1'];
  if (opts.siteId) {
    params.push(opts.siteId);
    where.push(`site_id = $${params.length}`);
  }
  if (opts.from) {
    params.push(opts.from);
    where.push(`ends_at > $${params.length}`);
  }
  if (opts.to) {
    params.push(opts.to);
    where.push(`starts_at < $${params.length}`);
  }
  const r = await query<ScheduleExceptionRow>(
    `SELECT * FROM schedule_exceptions WHERE ${where.join(' AND ')} ORDER BY starts_at`,
    params,
  );
  return r.rows;
}

export interface CreateExceptionInput {
  tenantId: string;
  siteId: string;
  staffId?: string | null;
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
}

export async function createException(input: CreateExceptionInput): Promise<ScheduleExceptionRow> {
  if (input.endsAt.getTime() <= input.startsAt.getTime()) {
    throw new Error('createException: ends_at must be after starts_at');
  }
  const r = await query<ScheduleExceptionRow>(
    `INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, reason)
       SELECT $1, $2, $3, $4, $5, $6
        WHERE EXISTS (SELECT 1 FROM sites WHERE id = $2 AND tenant_id = $1)
     RETURNING *`,
    [input.tenantId, input.siteId, input.staffId ?? null, input.startsAt, input.endsAt, input.reason ?? null],
  );
  if (!r.rows[0]) throw new Error('createException: site not found for tenant');
  return firstRowOrThrow(r, 'createException');
}

export async function deleteException(tenantId: string, id: string): Promise<boolean> {
  const r = await query(`DELETE FROM schedule_exceptions WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return (r.rowCount ?? 0) > 0;
}
