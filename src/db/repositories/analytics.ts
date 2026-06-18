import { query } from '../client.js';

/**
 * Analytics aggregations (CL-5). One generalized, tenant-scoped, parameterized
 * query set that is scoped by an OPTIONAL filter:
 *   - n8nWorkflowId set  → a single workflow (CL-5a per-workflow tab),
 *   - clientId set       → all workflows of one client (CL-5c, executions resolve
 *                          to a client THROUGH their workflow),
 *   - neither set        → the whole tenant (CL-5b Hub aggregate).
 * Each filter is `($p IS NULL OR <predicate>)`, so passing null = "no filter";
 * the per-workflow callers pass n8nWorkflowId and get byte-identical results to
 * before. Day bucketing is done in SQL with date_trunc in the tenant timezone
 * (America/Bogota), the range window anchored to the start of the (today − N + 1)
 * local day so the chart axis and the summary cover the same N calendar days.
 * Read-only; the worker never imports this.
 */

const TZ = 'America/Bogota';

export const ANALYTICS_RANGE_DAYS = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGE_DAYS)[number];

/** Coerce an untrusted value to a valid range, defaulting to 30. */
export function coerceRangeDays(value: unknown): AnalyticsRange {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return (ANALYTICS_RANGE_DAYS as readonly number[]).includes(n) ? (n as AnalyticsRange) : 30;
}

export interface ExecutionDayPoint {
  day: string;
  success: number;
  error: number;
  other: number;
}
export interface ExecutionSummary {
  total: number;
  success: number;
  error: number;
  other: number;
  avgDurationMs: number | null;
  allTimeTotal: number;
}
export interface ConversationDayPoint {
  day: string;
  turns: number;
}
export interface ConversationSummary {
  totalTurns: number;
  distinctConversations: number;
  allTimeTurns: number;
}
export interface TopClient {
  id: string;
  name: string;
  isDefault: boolean;
  logoUrl: string | null;
  executions: number;
}
export interface TopWorkflow {
  /** n8n workflow id. */
  id: string;
  name: string | null;
  executions: number;
}

/** Scope: tenant + range, optionally narrowed to one workflow or one client. */
export interface AnalyticsScope {
  tenantId: string;
  days: number;
  n8nWorkflowId?: string | null;
  clientId?: string | null;
}

// Param order for the scoped queries: $1 tenant, $2 days, $3 tz, $4 workflow, $5 client.
const params = (s: AnalyticsScope) =>
  [s.tenantId, s.days, TZ, s.n8nWorkflowId ?? null, s.clientId ?? null] as const;

// Reusable SQL fragments (executions `e` / turns `t` aliases).
const EXEC_FILTER = `($4::text IS NULL OR e.n8n_workflow_id = $4)
  AND ($5::uuid IS NULL OR EXISTS (
        SELECT 1 FROM workflows w
         WHERE w.tenant_id = e.tenant_id AND w.n8n_workflow_id = e.n8n_workflow_id AND w.client_id = $5))`;
const WINDOW_START = `(date_trunc('day', now() AT TIME ZONE $3) - make_interval(days => $2::int - 1)) AT TIME ZONE $3`;
const DAY_AXIS = `generate_series(
    (date_trunc('day', now() AT TIME ZONE $3)::date - ($2::int - 1)),
    (date_trunc('day', now() AT TIME ZONE $3)::date),
    interval '1 day'
  )`;

/** Daily execution counts by status (gap-filled over the range). */
export async function getExecutionDailySeries(s: AnalyticsScope): Promise<ExecutionDayPoint[]> {
  const r = await query<ExecutionDayPoint>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(e.id) FILTER (WHERE e.status = 'success')::int AS success,
            count(e.id) FILTER (WHERE e.status IN ('error', 'crashed'))::int AS error,
            count(e.id) FILTER (WHERE e.status NOT IN ('success', 'error', 'crashed'))::int AS other
       FROM ${DAY_AXIS} AS d(day)
       LEFT JOIN executions e
         ON e.tenant_id = $1
        AND ${EXEC_FILTER}
        AND e.started_at >= ${WINDOW_START}
        AND (e.started_at AT TIME ZONE $3)::date = d.day::date
      GROUP BY d.day
      ORDER BY d.day`,
    [...params(s)],
  );
  return r.rows;
}

/** Range totals (by status) + mean duration + all-time total, for the scope. */
export async function getExecutionSummary(s: AnalyticsScope): Promise<ExecutionSummary> {
  const r = await query<{
    total: number; success: number; error: number; other: number;
    avg_duration_ms: number | null; all_time_total: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'success')::int AS success,
            count(*) FILTER (WHERE status IN ('error', 'crashed'))::int AS error,
            count(*) FILTER (WHERE status NOT IN ('success', 'error', 'crashed'))::int AS other,
            avg(duration_ms)::float8 AS avg_duration_ms,
            (SELECT count(*)::int FROM executions e
              WHERE e.tenant_id = $1 AND ${EXEC_FILTER}) AS all_time_total
       FROM executions e
      WHERE e.tenant_id = $1
        AND ${EXEC_FILTER}
        AND e.started_at >= ${WINDOW_START}`,
    [...params(s)],
  );
  const row = r.rows[0];
  return {
    total: row.total,
    success: row.success,
    error: row.error,
    other: row.other,
    avgDurationMs: row.avg_duration_ms,
    allTimeTotal: row.all_time_total,
  };
}

/** Daily conversation-turn counts (gap-filled over the range). */
export async function getConversationDailySeries(s: AnalyticsScope): Promise<ConversationDayPoint[]> {
  const turnFilter = `($4::text IS NULL OR t.n8n_workflow_id = $4)
    AND ($5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM workflows w
           WHERE w.tenant_id = t.tenant_id AND w.n8n_workflow_id = t.n8n_workflow_id AND w.client_id = $5))`;
  const r = await query<ConversationDayPoint>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(t.id)::int AS turns
       FROM ${DAY_AXIS} AS d(day)
       LEFT JOIN conversation_turns t
         ON t.tenant_id = $1
        AND ${turnFilter}
        AND t.turn_timestamp >= ${WINDOW_START}
        AND (t.turn_timestamp AT TIME ZONE $3)::date = d.day::date
      GROUP BY d.day
      ORDER BY d.day`,
    [...params(s)],
  );
  return r.rows;
}

/** Range turn total + distinct conversations + all-time turns, for the scope. */
export async function getConversationSummary(s: AnalyticsScope): Promise<ConversationSummary> {
  const turnFilter = `($4::text IS NULL OR t.n8n_workflow_id = $4)
    AND ($5::uuid IS NULL OR EXISTS (
          SELECT 1 FROM workflows w
           WHERE w.tenant_id = t.tenant_id AND w.n8n_workflow_id = t.n8n_workflow_id AND w.client_id = $5))`;
  const r = await query<{
    total_turns: number; distinct_conversations: number; all_time_turns: number;
  }>(
    `SELECT count(*)::int AS total_turns,
            count(DISTINCT conversation_id)::int AS distinct_conversations,
            (SELECT count(*)::int FROM conversation_turns t
              WHERE t.tenant_id = $1 AND ${turnFilter}) AS all_time_turns
       FROM conversation_turns t
      WHERE t.tenant_id = $1
        AND ${turnFilter}
        AND t.turn_timestamp >= ${WINDOW_START}`,
    [...params(s)],
  );
  const row = r.rows[0];
  return {
    totalTurns: row.total_turns,
    distinctConversations: row.distinct_conversations,
    allTimeTurns: row.all_time_turns,
  };
}

// ---- Tenant-scoped aliases (CL-5b Hub; CL-5c passes clientId for one client) ----

interface TenantScope {
  tenantId: string;
  days: number;
  clientId?: string | null;
}
export const getTenantExecutionDailySeries = (s: TenantScope) =>
  getExecutionDailySeries({ tenantId: s.tenantId, days: s.days, clientId: s.clientId ?? null });
export const getTenantExecutionSummary = (s: TenantScope) =>
  getExecutionSummary({ tenantId: s.tenantId, days: s.days, clientId: s.clientId ?? null });
export const getTenantConversationSummary = (s: TenantScope) =>
  getConversationSummary({ tenantId: s.tenantId, days: s.days, clientId: s.clientId ?? null });

/**
 * Top clients by execution count in the range, tenant-wide. Each execution is
 * attributed to the client of its CANONICAL workflow row (most recently synced
 * per n8n id — matching getWorkflowByN8nId), so an n8n id under multiple
 * connections isn't double-counted. Executions whose workflow has no row are
 * unattributable and excluded (so the sum can be < total executions).
 */
export async function getTopClientsByExecutions(s: {
  tenantId: string;
  days: number;
  limit: number;
}): Promise<TopClient[]> {
  const r = await query<{
    id: string; name: string; is_default: boolean; logo_url: string | null; executions: number;
  }>(
    `WITH wf AS (
        SELECT DISTINCT ON (n8n_workflow_id) n8n_workflow_id, client_id
          FROM workflows
         WHERE tenant_id = $1
         ORDER BY n8n_workflow_id, last_synced_at DESC NULLS LAST
     )
     SELECT cl.id, cl.name, cl.is_default, cl.logo_url, count(e.id)::int AS executions
       FROM executions e
       JOIN wf ON wf.n8n_workflow_id = e.n8n_workflow_id
       JOIN clients cl ON cl.id = wf.client_id
      WHERE e.tenant_id = $1
        AND e.started_at >= (date_trunc('day', now() AT TIME ZONE $3) - make_interval(days => $2::int - 1)) AT TIME ZONE $3
      GROUP BY cl.id
      ORDER BY executions DESC, lower(cl.name)
      LIMIT $4`,
    [s.tenantId, s.days, TZ, s.limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    name: row.name,
    isDefault: row.is_default,
    logoUrl: row.logo_url,
    executions: row.executions,
  }));
}

/**
 * Top workflows by execution count WITHIN one client, in the range (the
 * per-workflow breakdown on a client's "All workflows" analytics view). Each
 * execution is attributed to the canonical workflow row (most recently synced
 * per n8n id); only the given client's workflows are considered.
 */
export async function getTopWorkflowsByExecutions(s: {
  tenantId: string;
  clientId: string;
  days: number;
  limit: number;
}): Promise<TopWorkflow[]> {
  const r = await query<{ id: string; name: string | null; executions: number }>(
    `WITH wf AS (
        SELECT DISTINCT ON (n8n_workflow_id) n8n_workflow_id, name, client_id
          FROM workflows
         WHERE tenant_id = $1
         ORDER BY n8n_workflow_id, last_synced_at DESC NULLS LAST
     )
     SELECT wf.n8n_workflow_id AS id, wf.name, count(e.id)::int AS executions
       FROM executions e
       JOIN wf ON wf.n8n_workflow_id = e.n8n_workflow_id
      WHERE e.tenant_id = $1
        AND wf.client_id = $4
        AND e.started_at >= (date_trunc('day', now() AT TIME ZONE $3) - make_interval(days => $2::int - 1)) AT TIME ZONE $3
      GROUP BY wf.n8n_workflow_id, wf.name
      ORDER BY executions DESC, lower(coalesce(wf.name, wf.n8n_workflow_id))
      LIMIT $5`,
    [s.tenantId, s.days, TZ, s.clientId, s.limit],
  );
  return r.rows;
}
