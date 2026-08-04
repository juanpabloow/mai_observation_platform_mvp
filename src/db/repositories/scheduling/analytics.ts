import { query } from '../../client.js';

/**
 * READ-ONLY scheduling analytics — SQL aggregations only (COUNT/FILTER/SUM/GROUP BY),
 * never loading appointment rows into JavaScript. Every query is anchored to a single
 * (tenant_id, client_id, site_id) plus a half-open `[from, to)` UTC window; the caller
 * (the web page) converts the site's LOCAL date range to that UTC window via the
 * timezone helpers, so all boundaries are honest and DST-correct.
 *
 * CROSS-CLIENT / CROSS-TENANT DEFENSE: site_id is joined on tenant + client
 * (si.client_id = a.client_id), and staff on tenant + site; a foreign site/staff id
 * simply matches nothing (0 rows) — it never widens or leaks another client's data.
 * The client_id filter is ALWAYS applied explicitly, even for owner/admin.
 *
 * Money is DENORMALIZED at booking time in price_snapshot (text numeric). We only
 * ever SUM completed vs active — never call it "revenue": there is no payments data.
 */

export interface AnalyticsFilters {
  clientId: string;
  siteId: string;
  from: Date;
  to: Date;
  staffId?: string;
  serviceId?: string;
}

/** Shared WHERE for every aggregate. site_id is REQUIRED (analytics is per-site so the
 * timezone is unambiguous). Returns the SQL fragment + positional params starting at $1
 * = tenantId. */
function buildWhere(tenantId: string, f: AnalyticsFilters): { where: string; params: unknown[] } {
  const params: unknown[] = [tenantId, f.clientId, f.siteId, f.from, f.to];
  const where = [
    'a.tenant_id = $1',
    'a.client_id = $2',
    'a.site_id = $3',
    'a.start_at >= $4',
    'a.start_at < $5',
  ];
  if (f.staffId) {
    params.push(f.staffId);
    where.push(`a.staff_id = $${params.length}`);
  }
  if (f.serviceId) {
    params.push(f.serviceId);
    where.push(`a.service_id = $${params.length}`);
  }
  return { where: where.join(' AND '), params };
}

/** The per-status COUNT FILTER + monetary SUM FILTER columns, reused by every
 * aggregate so a barber/service/day row carries the same shape as the totals. */
const STATUS_COLUMNS = `
  COUNT(*)::int AS total,
  COUNT(*) FILTER (WHERE a.status = 'scheduled')::int AS scheduled,
  COUNT(*) FILTER (WHERE a.status = 'confirmed')::int AS confirmed,
  COUNT(*) FILTER (WHERE a.status = 'completed')::int AS completed,
  COUNT(*) FILTER (WHERE a.status = 'cancelled')::int AS cancelled,
  COUNT(*) FILTER (WHERE a.status = 'no_show')::int AS no_show,
  COALESCE(SUM(a.price_snapshot::numeric) FILTER (WHERE a.status = 'completed'), 0)::text AS completed_value,
  COALESCE(SUM(a.price_snapshot::numeric) FILTER (WHERE a.status IN ('scheduled','confirmed')), 0)::text AS scheduled_value
`;

interface StatusCountsRow {
  total: number;
  scheduled: number;
  confirmed: number;
  completed: number;
  cancelled: number;
  no_show: number;
  completed_value: string;
  scheduled_value: string;
}

export interface AppointmentMetrics extends StatusCountsRow {
  /** completed / total (0 when total = 0). */
  completion_rate: number;
  cancellation_rate: number;
  no_show_rate: number;
}

const ZERO_COUNTS: StatusCountsRow = {
  total: 0,
  scheduled: 0,
  confirmed: 0,
  completed: 0,
  cancelled: 0,
  no_show: 0,
  completed_value: '0',
  scheduled_value: '0',
};

function withRates(c: StatusCountsRow): AppointmentMetrics {
  const rate = (n: number): number => (c.total > 0 ? n / c.total : 0);
  return {
    ...c,
    completion_rate: rate(c.completed),
    cancellation_rate: rate(c.cancelled),
    no_show_rate: rate(c.no_show),
  };
}

/** Totals + per-status distribution + monetary values for the whole window. ONE query. */
export async function getAppointmentMetrics(tenantId: string, f: AnalyticsFilters): Promise<AppointmentMetrics> {
  const { where, params } = buildWhere(tenantId, f);
  const r = await query<StatusCountsRow>(
    `SELECT ${STATUS_COLUMNS} FROM appointments a WHERE ${where}`,
    params,
  );
  return withRates(r.rows[0] ?? ZERO_COUNTS);
}

export interface DayBucket extends StatusCountsRow {
  /** Local calendar date (site timezone) as "YYYY-MM-DD". */
  day: string;
}

/**
 * Appointments per LOCAL day (site timezone). Grouping is done in SQL with
 * `(a.start_at AT TIME ZONE $tz)::date`, so a day boundary is the site's local
 * midnight — never UTC's and never the server's. ONE query, ordered by day.
 */
export async function getAppointmentsByDay(tenantId: string, f: AnalyticsFilters, timezone: string): Promise<DayBucket[]> {
  const { where, params } = buildWhere(tenantId, f);
  params.push(timezone);
  const tzPos = params.length;
  const r = await query<DayBucket>(
    `SELECT to_char((a.start_at AT TIME ZONE $${tzPos})::date, 'YYYY-MM-DD') AS day, ${STATUS_COLUMNS}
       FROM appointments a
      WHERE ${where}
      GROUP BY (a.start_at AT TIME ZONE $${tzPos})::date
      ORDER BY (a.start_at AT TIME ZONE $${tzPos})::date ASC`,
    params,
  );
  return r.rows;
}

export interface StaffBucket extends StatusCountsRow {
  staff_id: string;
  staff_name: string | null;
}

/** Aggregation per barber. INNER JOIN staff on tenant + site keeps a foreign-staff
 * row from ever appearing; name comes from the JOIN, never a snapshot. ONE query. */
export async function getAppointmentsByStaff(tenantId: string, f: AnalyticsFilters): Promise<StaffBucket[]> {
  const { where, params } = buildWhere(tenantId, f);
  const r = await query<StaffBucket>(
    `SELECT a.staff_id, st.name AS staff_name, ${STATUS_COLUMNS}
       FROM appointments a
       JOIN staff st ON st.id = a.staff_id AND st.tenant_id = a.tenant_id AND st.site_id = a.site_id
      WHERE ${where}
      GROUP BY a.staff_id, st.name
      ORDER BY total DESC, st.name ASC`,
    params,
  );
  return r.rows;
}

export interface ServiceBucket extends StatusCountsRow {
  service_id: string;
  service_name: string;
}

/** Aggregation per service. Uses the denormalized service_name_snapshot (a service
 * renamed after booking still groups under the name customers saw). ONE query. */
export async function getAppointmentsByService(tenantId: string, f: AnalyticsFilters): Promise<ServiceBucket[]> {
  const { where, params } = buildWhere(tenantId, f);
  const r = await query<ServiceBucket>(
    `SELECT a.service_id, a.service_name_snapshot AS service_name, ${STATUS_COLUMNS}
       FROM appointments a
      WHERE ${where}
      GROUP BY a.service_id, a.service_name_snapshot
      ORDER BY total DESC, service_name ASC`,
    params,
  );
  return r.rows;
}
