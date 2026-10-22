import type { PoolClient } from 'pg';
import { query } from '../../client.js';
import { localDatesInRange } from '../../../scheduling/timezone.js';
import {
  occurrencesInWindow,
  type Occurrence,
  type ScheduleSeries,
  type SeriesKind,
  type SeriesOp,
  type SeriesOverride,
} from '../../../scheduling/series.js';

/**
 * schedule_series / schedule_series_overrides repository (migration 1818). Tenant + site
 * scoped on every read; dates travel as local "YYYY-MM-DD" strings (never JS Dates), exactly
 * the shape the pure engine (src/scheduling/series.ts) works in.
 */

const SERIES_COLS = `id, site_id, staff_id, kind, weekdays::int[] AS weekdays, start_min, end_min,
  to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on,
  reason, public_reason, split_from_id`;

export interface ScheduleSeriesRow extends ScheduleSeries {
  split_from_id: string | null;
}

type Exec = Pick<PoolClient, 'query'>;
const pooled: Exec = { query: ((text: string, params?: unknown[]) => query(text, params)) as PoolClient['query'] };

export async function listSeries(
  tenantId: string,
  siteId: string,
  opts: { kind?: SeriesKind; staffIds?: string[] | null; siteWide?: boolean; fromDate?: string; toDate?: string } = {},
  exec: Exec = pooled,
): Promise<ScheduleSeriesRow[]> {
  const params: unknown[] = [tenantId, siteId];
  const where = ['tenant_id = $1', 'site_id = $2'];
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.staffIds) {
    params.push(opts.staffIds);
    where.push(opts.siteWide === false
      ? `staff_id = ANY($${params.length}::uuid[])`
      : `(staff_id IS NULL OR staff_id = ANY($${params.length}::uuid[]))`);
  } else if (opts.siteWide === true) {
    where.push('staff_id IS NULL');
  }
  if (opts.fromDate) {
    params.push(opts.fromDate);
    where.push(`(ends_on IS NULL OR ends_on >= $${params.length}::date)`);
  }
  if (opts.toDate) {
    params.push(opts.toDate);
    where.push(`(starts_on IS NULL OR starts_on <= $${params.length}::date)`);
  }
  const r = await exec.query<ScheduleSeriesRow>(
    `SELECT ${SERIES_COLS} FROM schedule_series WHERE ${where.join(' AND ')}
      ORDER BY staff_id NULLS FIRST, starts_on NULLS FIRST, start_min, id`,
    params,
  );
  return r.rows;
}

export async function listOverrides(
  tenantId: string,
  seriesIds: string[],
  opts: { fromDate?: string; toDate?: string } = {},
  exec: Exec = pooled,
): Promise<SeriesOverride[]> {
  if (seriesIds.length === 0) return [];
  const params: unknown[] = [tenantId, seriesIds];
  const where = ['tenant_id = $1', 'series_id = ANY($2::uuid[])'];
  if (opts.fromDate) {
    params.push(opts.fromDate);
    where.push(`occurrence_date >= $${params.length}::date`);
  }
  if (opts.toDate) {
    params.push(opts.toDate);
    where.push(`occurrence_date <= $${params.length}::date`);
  }
  const r = await exec.query<SeriesOverride>(
    `SELECT series_id, to_char(occurrence_date, 'YYYY-MM-DD') AS occurrence_date, action, start_min, end_min
       FROM schedule_series_overrides WHERE ${where.join(' AND ')} ORDER BY occurrence_date`,
    params,
  );
  return r.rows;
}

/** One series, tenant-scoped, optionally row-locked inside a transaction. */
export async function getSeries(
  tenantId: string,
  id: string,
  exec: Exec = pooled,
  lock = false,
): Promise<(ScheduleSeriesRow & { client_id: string }) | null> {
  const r = await exec.query<ScheduleSeriesRow & { client_id: string }>(
    `SELECT ${SERIES_COLS}, client_id FROM schedule_series WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenantId, id],
  );
  return r.rows[0] ?? null;
}

/** Lock every series of one owner (site-wide when staffId is null) — serialises concurrent
 *  routine edits of the same schedule. */
export async function lockOwnerSeries(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  staffId: string | null,
  kind: SeriesKind,
): Promise<ScheduleSeriesRow[]> {
  // An advisory lock covers the "no rows yet" case FOR UPDATE cannot.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
    `schedule_series:${tenantId}:${siteId}:${staffId ?? 'site'}:${kind}`,
  ]);
  const r = await client.query<ScheduleSeriesRow>(
    `SELECT ${SERIES_COLS} FROM schedule_series
      WHERE tenant_id = $1 AND site_id = $2 AND kind = $3
        AND ${staffId ? 'staff_id = $4' : 'staff_id IS NULL'}
      ORDER BY id FOR UPDATE`,
    staffId ? [tenantId, siteId, kind, staffId] : [tenantId, siteId, kind],
  );
  return r.rows;
}

/** Execute a plan from the engine, in order, inside the caller's transaction. Returns the
 *  ids of series it created, by plan ref. Every write is tenant + client scoped. */
export async function applySeriesOps(
  client: PoolClient,
  scope: { tenantId: string; clientId: string; userId: string | null },
  ops: SeriesOp[],
): Promise<Record<string, string>> {
  const created: Record<string, string> = {};
  const { tenantId, clientId, userId } = scope;
  for (const op of ops) {
    switch (op.op) {
      case 'create': {
        const f = op.fields;
        const r = await client.query<{ id: string }>(
          `INSERT INTO schedule_series
             (tenant_id, client_id, site_id, staff_id, kind, weekdays, start_min, end_min,
              starts_on, ends_on, reason, public_reason, split_from_id, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7, $8, $9::date, $10::date, $11, $12, $13, $14)
           RETURNING id`,
          [tenantId, clientId, f.site_id, f.staff_id, f.kind, f.weekdays, f.start_min, f.end_min,
            f.starts_on, f.ends_on, f.reason, f.public_reason, op.split_from_id, userId],
        );
        created[op.ref] = r.rows[0].id;
        break;
      }
      case 'update': {
        const sets: string[] = [];
        const params: unknown[] = [tenantId, op.id];
        const add = (col: string, v: unknown, cast = '') => {
          params.push(v);
          sets.push(`${col} = $${params.length}${cast}`);
        };
        if (op.set.weekdays !== undefined) add('weekdays', op.set.weekdays, '::smallint[]');
        if (op.set.start_min !== undefined) add('start_min', op.set.start_min);
        if (op.set.end_min !== undefined) add('end_min', op.set.end_min);
        if (op.set.ends_on !== undefined) add('ends_on', op.set.ends_on, '::date');
        if (op.set.reason !== undefined) add('reason', op.set.reason);
        if (op.set.public_reason !== undefined) add('public_reason', op.set.public_reason);
        if (sets.length === 0) break;
        await client.query(
          `UPDATE schedule_series SET ${sets.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
          params,
        );
        break;
      }
      case 'end':
        await client.query(
          `UPDATE schedule_series SET ends_on = $3::date, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
          [tenantId, op.id, op.ends_on],
        );
        break;
      case 'delete':
        await client.query(`DELETE FROM schedule_series WHERE tenant_id = $1 AND id = $2`, [tenantId, op.id]);
        break;
      case 'upsert_override': {
        const seriesId = 'id' in op.series ? op.series.id : created[op.series.ref];
        if (!seriesId) throw new Error(`applySeriesOps: unknown series ref`);
        await client.query(
          `INSERT INTO schedule_series_overrides (tenant_id, series_id, occurrence_date, action, start_min, end_min, created_by_user_id)
           VALUES ($1, $2, $3::date, $4, $5, $6, $7)
           ON CONFLICT (series_id, occurrence_date)
           DO UPDATE SET action = EXCLUDED.action, start_min = EXCLUDED.start_min, end_min = EXCLUDED.end_min,
                         created_by_user_id = EXCLUDED.created_by_user_id, updated_at = now()`,
          [tenantId, seriesId, op.date, op.action, op.start_min, op.end_min, userId],
        );
        break;
      }
      case 'delete_override':
        await client.query(
          `DELETE FROM schedule_series_overrides WHERE tenant_id = $1 AND series_id = $2 AND occurrence_date = $3::date`,
          [tenantId, op.series_id, op.date],
        );
        break;
      case 'delete_overrides_from':
        await client.query(
          `DELETE FROM schedule_series_overrides
            WHERE tenant_id = $1 AND series_id = $2 AND occurrence_date >= $3::date
              AND ($4::text IS NULL OR action = $4)`,
          [tenantId, op.series_id, op.from, op.action ?? null],
        );
        break;
    }
  }
  return created;
}

/**
 * Every occurrence (breaks AND recurring blocks) that touches the UTC window, for the site
 * (staff_id NULL) and the given professionals. THE read the availability loader, the
 * calendar and the conflict check share.
 */
export async function loadOccurrences(params: {
  tenantId: string;
  siteId: string;
  timeZone: string;
  from: Date;
  to: Date;
  staffIds: string[] | null;
  kind?: SeriesKind;
}): Promise<Occurrence[]> {
  const dates = localDatesInRange(params.from, params.to, params.timeZone);
  if (dates.length === 0) return [];
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: { year: number; month: number; day: number }) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  const fromDate = iso(dates[0]);
  const toDate = iso(dates[dates.length - 1]);
  const series = await listSeries(params.tenantId, params.siteId, {
    kind: params.kind,
    staffIds: params.staffIds,
    fromDate,
    toDate,
  });
  if (series.length === 0) return [];
  const overrides = await listOverrides(params.tenantId, series.map((s) => s.id), { fromDate, toDate });
  return occurrencesInWindow(series, overrides, params.from, params.to, params.timeZone);
}

/** Write a schedule owner's weekly hours inside the caller's transaction (site opening
 *  hours, or a professional's own hours — `{}` = inherits the site). */
export async function setOwnerHours(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  staffId: string | null,
  hours: Record<string, Array<{ start: string; end: string }>>,
): Promise<boolean> {
  const r = staffId
    ? await client.query(
        `UPDATE staff SET working_hours = $4::jsonb, updated_at = now() WHERE tenant_id = $1 AND site_id = $2 AND id = $3`,
        [tenantId, siteId, staffId, JSON.stringify(hours)],
      )
    : await client.query(
        `UPDATE sites SET opening_hours = $3::jsonb, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
        [tenantId, siteId, JSON.stringify(hours)],
      );
  return (r.rowCount ?? 0) > 0;
}

/** Current weekly hours of an owner, row-locked (serialises concurrent schedule saves). */
export async function getOwnerHoursForUpdate(
  client: PoolClient,
  tenantId: string,
  siteId: string,
  staffId: string | null,
): Promise<Record<string, Array<{ start: string; end: string }>> | null> {
  const r = staffId
    ? await client.query<{ h: Record<string, Array<{ start: string; end: string }>> }>(
        `SELECT working_hours AS h FROM staff WHERE tenant_id = $1 AND site_id = $2 AND id = $3 FOR UPDATE`,
        [tenantId, siteId, staffId],
      )
    : await client.query<{ h: Record<string, Array<{ start: string; end: string }>> }>(
        `SELECT opening_hours AS h FROM sites WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [tenantId, siteId],
      );
  return r.rows[0]?.h ?? null;
}
