import { query } from '../client.js';

/**
 * Per-workflow analytics aggregations (CL-5a). All queries are tenant + workflow
 * scoped and fully parameterized (tenant, workflow, range-days, timezone — no
 * interpolation). Day bucketing is done in SQL with date_trunc in the tenant
 * timezone (America/Bogota, matching how the rest of the app presents dates), and
 * the series queries LEFT JOIN a generate_series day axis so every day in the
 * range is present (gaps filled with 0). The range-day window is anchored to the
 * START of the (today − N + 1) local day, so the chart axis and the summary
 * counts cover the exact same N calendar days. Read-only; the worker never imports
 * this (CL-5b/5c will reuse these for the tenant Hub + "all workflows").
 */

/** The server timezone used for day bucketing (matches the app's date display). */
const TZ = 'America/Bogota';

/** Allowed analytics ranges (days). The selector + URL param validate against these. */
export const ANALYTICS_RANGE_DAYS = [7, 30, 90] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGE_DAYS)[number];

/** Coerce an untrusted value to a valid range, defaulting to 30. */
export function coerceRangeDays(value: unknown): AnalyticsRange {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return (ANALYTICS_RANGE_DAYS as readonly number[]).includes(n) ? (n as AnalyticsRange) : 30;
}

export interface ExecutionDayPoint {
  /** Local (Bogota) calendar day, YYYY-MM-DD. */
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
  /** Mean duration_ms over the range, or null when there are no executions. */
  avgDurationMs: number | null;
  /** All-time execution count for the workflow (range-independent). */
  allTimeTotal: number;
}

export interface ConversationDayPoint {
  day: string;
  turns: number;
}

export interface ConversationSummary {
  totalTurns: number;
  distinctConversations: number;
  /** All-time turns — used to decide whether to show the conversation section. */
  allTimeTurns: number;
}

interface Scope {
  tenantId: string;
  n8nWorkflowId: string;
  days: number;
}

/** Daily execution counts by status (success / error+crashed / other), gap-filled. */
export async function getExecutionDailySeries(s: Scope): Promise<ExecutionDayPoint[]> {
  const r = await query<ExecutionDayPoint>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(e.id) FILTER (WHERE e.status = 'success')::int AS success,
            count(e.id) FILTER (WHERE e.status IN ('error', 'crashed'))::int AS error,
            count(e.id) FILTER (WHERE e.status NOT IN ('success', 'error', 'crashed'))::int AS other
       FROM generate_series(
              (date_trunc('day', now() AT TIME ZONE $4)::date - ($3::int - 1)),
              (date_trunc('day', now() AT TIME ZONE $4)::date),
              interval '1 day'
            ) AS d(day)
       LEFT JOIN executions e
         ON e.tenant_id = $1
        AND e.n8n_workflow_id = $2
        AND e.started_at >= (date_trunc('day', now() AT TIME ZONE $4) - make_interval(days => $3::int - 1)) AT TIME ZONE $4
        AND (e.started_at AT TIME ZONE $4)::date = d.day::date
      GROUP BY d.day
      ORDER BY d.day`,
    [s.tenantId, s.n8nWorkflowId, s.days, TZ],
  );
  return r.rows;
}

/** Range totals (by status), mean duration, and the all-time total. */
export async function getExecutionSummary(s: Scope): Promise<ExecutionSummary> {
  const r = await query<{
    total: number; success: number; error: number; other: number;
    avg_duration_ms: number | null; all_time_total: number;
  }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'success')::int AS success,
            count(*) FILTER (WHERE status IN ('error', 'crashed'))::int AS error,
            count(*) FILTER (WHERE status NOT IN ('success', 'error', 'crashed'))::int AS other,
            avg(duration_ms)::float8 AS avg_duration_ms,
            (SELECT count(*)::int FROM executions
              WHERE tenant_id = $1 AND n8n_workflow_id = $2) AS all_time_total
       FROM executions
      WHERE tenant_id = $1 AND n8n_workflow_id = $2
        AND started_at >= (date_trunc('day', now() AT TIME ZONE $4) - make_interval(days => $3::int - 1)) AT TIME ZONE $4`,
    [s.tenantId, s.n8nWorkflowId, s.days, TZ],
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

/** Daily conversation-turn counts, gap-filled over the range. */
export async function getConversationDailySeries(s: Scope): Promise<ConversationDayPoint[]> {
  const r = await query<ConversationDayPoint>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            count(t.id)::int AS turns
       FROM generate_series(
              (date_trunc('day', now() AT TIME ZONE $4)::date - ($3::int - 1)),
              (date_trunc('day', now() AT TIME ZONE $4)::date),
              interval '1 day'
            ) AS d(day)
       LEFT JOIN conversation_turns t
         ON t.tenant_id = $1
        AND t.n8n_workflow_id = $2
        AND t.turn_timestamp >= (date_trunc('day', now() AT TIME ZONE $4) - make_interval(days => $3::int - 1)) AT TIME ZONE $4
        AND (t.turn_timestamp AT TIME ZONE $4)::date = d.day::date
      GROUP BY d.day
      ORDER BY d.day`,
    [s.tenantId, s.n8nWorkflowId, s.days, TZ],
  );
  return r.rows;
}

/** Range turn total + distinct conversations, plus the all-time turn count. */
export async function getConversationSummary(s: Scope): Promise<ConversationSummary> {
  const r = await query<{
    total_turns: number; distinct_conversations: number; all_time_turns: number;
  }>(
    `SELECT count(*)::int AS total_turns,
            count(DISTINCT conversation_id)::int AS distinct_conversations,
            (SELECT count(*)::int FROM conversation_turns
              WHERE tenant_id = $1 AND n8n_workflow_id = $2) AS all_time_turns
       FROM conversation_turns
      WHERE tenant_id = $1 AND n8n_workflow_id = $2
        AND turn_timestamp >= (date_trunc('day', now() AT TIME ZONE $4) - make_interval(days => $3::int - 1)) AT TIME ZONE $4`,
    [s.tenantId, s.n8nWorkflowId, s.days, TZ],
  );
  const row = r.rows[0];
  return {
    totalTurns: row.total_turns,
    distinctConversations: row.distinct_conversations,
    allTimeTurns: row.all_time_turns,
  };
}
