import { query } from '../client.js';

/**
 * COSTOS DE IA → Ejecuciones — how many n8n executions the bots consume, from the executions the
 * worker already ingests. Tenant-scoped; `clientId` limits every read to one business.
 *
 * n8n bills PRODUCTION executions only, so `manual` runs (editor tests, QA) are counted apart and
 * never against the plan. Categories are exclusive:
 *   with_ai   the run called the model (the useful replies)
 *   errors    failed/crashed without calling the model
 *   unread    unknown: not scanned yet (backfill pending) or n8n kept no run data, never "no AI"
 *   no_ai     everything else: stopped early (WhatsApp status notices, debounce, human mode…)
 */

export interface ExecPeriod {
  tenantId: string;
  from: Date;
  to: Date;
  timeZone: string;
  clientId?: string | null;
}

const CLIENT_FILTER = `($CLIENT::uuid IS NULL OR EXISTS (
    SELECT 1 FROM workflows w
     WHERE w.tenant_id = e.tenant_id AND w.n8n_connection_id = e.n8n_connection_id
       AND w.n8n_workflow_id = e.n8n_workflow_id AND w.client_id = $CLIENT))`;

export interface ExecDayRow {
  day: string;
  production: number;
  manual: number;
  with_ai: number;
  errors: number;
  unread: number;
  /** Sum and count of production durations (stopped − started), for the average. */
  duration_ms_sum: number;
  duration_n: number;
}

export async function listExecutionDays(p: ExecPeriod): Promise<ExecDayRow[]> {
  const r = await query<ExecDayRow>(
    `SELECT to_char((e.started_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
            count(*) FILTER (WHERE e.mode IS DISTINCT FROM 'manual')::int AS production,
            count(*) FILTER (WHERE e.mode = 'manual')::int AS manual,
            count(*) FILTER (WHERE e.mode IS DISTINCT FROM 'manual' AND s.llm_calls > 0)::int AS with_ai,
            count(*) FILTER (WHERE e.mode IS DISTINCT FROM 'manual' AND coalesce(s.llm_calls, 0) = 0
                               AND e.status IN ('error', 'crashed'))::int AS errors,
            count(*) FILTER (WHERE e.mode IS DISTINCT FROM 'manual' AND (s.execution_id IS NULL OR NOT s.has_run_data)
                               AND e.status NOT IN ('error', 'crashed'))::int AS unread,
            coalesce(sum(e.duration_ms) FILTER (WHERE e.mode IS DISTINCT FROM 'manual' AND e.duration_ms >= 0), 0)::float8 AS duration_ms_sum,
            count(e.duration_ms) FILTER (WHERE e.mode IS DISTINCT FROM 'manual' AND e.duration_ms >= 0)::int AS duration_n
       FROM executions e
       LEFT JOIN execution_llm_scans s ON s.execution_id = e.id
      WHERE e.tenant_id = $1 AND e.started_at >= $2 AND e.started_at < $3
        AND ${CLIENT_FILTER.replace(/\$CLIENT/g, '$5')}
      GROUP BY 1 ORDER BY 1`,
    [p.tenantId, p.from, p.to, p.timeZone, p.clientId ?? null],
  );
  return r.rows;
}

export interface ExecEndingRow {
  workflow: string;
  client_name: string | null;
  last_node: string;
  manual: boolean;
  executions: number;
  with_ai: number;
  errors: number;
}

/** Where executions end, per workflow — the node a run stopped at tells why it was (not) useful. */
export async function listExecutionEndings(p: ExecPeriod, limit = 30): Promise<ExecEndingRow[]> {
  const r = await query<ExecEndingRow>(
    `SELECT coalesce(w.name, max(e.workflow_name), e.n8n_workflow_id) AS workflow,
            c.name AS client_name,
            coalesce(e.raw_data->'resultData'->>'lastNodeExecuted', '') AS last_node,
            (e.mode = 'manual') AS manual,
            count(*)::int AS executions,
            count(*) FILTER (WHERE s.llm_calls > 0)::int AS with_ai,
            count(*) FILTER (WHERE e.status IN ('error', 'crashed'))::int AS errors
       FROM executions e
       LEFT JOIN execution_llm_scans s ON s.execution_id = e.id
       LEFT JOIN workflows w ON w.tenant_id = e.tenant_id AND w.n8n_connection_id = e.n8n_connection_id
                            AND w.n8n_workflow_id = e.n8n_workflow_id
       LEFT JOIN clients c ON c.id = w.client_id AND c.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.started_at >= $2 AND e.started_at < $3
        AND ($4::uuid IS NULL OR w.client_id = $4)
      GROUP BY w.name, e.n8n_workflow_id, c.name, 3, 4
      ORDER BY executions DESC
      LIMIT $5`,
    [p.tenantId, p.from, p.to, p.clientId ?? null, limit],
  );
  return r.rows;
}

export type UsageBy = 'client' | 'workflow';

export interface ExecUsageRow {
  day: string;
  /** client id, or `<connection>:<workflow id>`; '' = workflow not synced (no business). */
  key: string;
  name: string | null;
  /** Business palette slot («Clientes y workflows»); null for workflows / automatic. */
  chart_color: string | null;
  production: number;
  with_ai: number;
  errors: number;
  unread: number;
}

/**
 * Production executions per local day and per business or workflow — who uses the platform
 * most, over time. Same categories as listExecutionDays; manual runs excluded (not billed).
 */
export async function listExecutionUsage(p: ExecPeriod, by: UsageBy): Promise<ExecUsageRow[]> {
  const key = by === 'client' ? `coalesce(w.client_id::text, '')` : `e.n8n_connection_id::text || ':' || e.n8n_workflow_id`;
  // The default client is the "no business" bucket: no name, so the screen says so.
  const name = by === 'client' ? `CASE WHEN bool_or(c.is_default) THEN NULL ELSE max(c.name) END` : `coalesce(max(w.name), max(e.workflow_name), max(e.n8n_workflow_id))`;
  const color = by === 'client' ? `max(c.chart_color)` : `NULL::text`;
  const r = await query<ExecUsageRow>(
    `SELECT to_char((e.started_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
            ${key} AS key, ${name} AS name, ${color} AS chart_color,
            count(*)::int AS production,
            count(*) FILTER (WHERE s.llm_calls > 0)::int AS with_ai,
            count(*) FILTER (WHERE coalesce(s.llm_calls, 0) = 0 AND e.status IN ('error', 'crashed'))::int AS errors,
            count(*) FILTER (WHERE (s.execution_id IS NULL OR NOT s.has_run_data) AND e.status NOT IN ('error', 'crashed'))::int AS unread
       FROM executions e
       LEFT JOIN execution_llm_scans s ON s.execution_id = e.id
       LEFT JOIN workflows w ON w.tenant_id = e.tenant_id AND w.n8n_connection_id = e.n8n_connection_id
                            AND w.n8n_workflow_id = e.n8n_workflow_id
       LEFT JOIN clients c ON c.id = w.client_id AND c.tenant_id = e.tenant_id
      WHERE e.tenant_id = $1 AND e.started_at >= $2 AND e.started_at < $3 AND e.mode IS DISTINCT FROM 'manual'
        AND ($5::uuid IS NULL OR w.client_id = $5)
      GROUP BY 1, 2
      ORDER BY 1, 2`,
    [p.tenantId, p.from, p.to, p.timeZone, p.clientId ?? null],
  );
  return r.rows;
}

export interface InboxSendsRow {
  total: number;
  accepted: number;
  failed: number;
  pending: number;
  failed_by_code: Array<{ code: string; count: number }>;
}

/**
 * Replies a person sent from the Inbox in the period (handoff_messages from `human_agent`):
 * accepted by the workflow, failed (with the provider's code) or still sending. A separate
 * measure from execution success — a caught provider error still ends the run as `success`.
 * «Accepted» is not «delivered»: WhatsApp delivery receipts are not tracked.
 */
export async function getInboxSends(p: ExecPeriod): Promise<InboxSendsRow> {
  const r = await query<InboxSendsRow>(
    `WITH m AS (
       SELECT hm.status, hm.failure_code
         FROM handoff_messages hm
         JOIN conversations c ON c.id = hm.conversation_id AND c.tenant_id = hm.tenant_id
        WHERE hm.tenant_id = $1 AND hm.sender = 'human_agent' AND hm.occurred_at >= $2 AND hm.occurred_at < $3
          AND ($4::uuid IS NULL OR EXISTS (
                SELECT 1 FROM workflows w
                 WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id AND w.client_id = $4))
     )
     SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status = 'sent')::int AS accepted,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            count(*) FILTER (WHERE status = 'sending')::int AS pending,
            coalesce((SELECT jsonb_agg(jsonb_build_object('code', code, 'count', n) ORDER BY n DESC, code)
                        FROM (SELECT coalesce(failure_code, 'UNKNOWN') AS code, count(*)::int AS n
                                FROM m WHERE status = 'failed' GROUP BY 1) f), '[]'::jsonb) AS failed_by_code
       FROM m`,
    [p.tenantId, p.from, p.to, p.clientId ?? null],
  );
  return r.rows[0];
}

export interface ConnectionPlanRow {
  id: string;
  name: string;
  plan_monthly_executions: number | null;
  plan_reset_day: number | null;
}

export async function listConnectionPlans(tenantId: string): Promise<ConnectionPlanRow[]> {
  const r = await query<ConnectionPlanRow>(
    `SELECT id, name, plan_monthly_executions, plan_reset_day
       FROM n8n_connections WHERE tenant_id = $1 AND is_active ORDER BY name`,
    [tenantId],
  );
  return r.rows;
}

/** Production executions of one connection since `since` (the current plan cycle). */
export async function countProductionExecutions(tenantId: string, connectionId: string, since: Date): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM executions
      WHERE tenant_id = $1 AND n8n_connection_id = $2 AND started_at >= $3 AND mode IS DISTINCT FROM 'manual'`,
    [tenantId, connectionId, since],
  );
  return r.rows[0]?.n ?? 0;
}

export async function setConnectionPlan(p: {
  tenantId: string;
  connectionId: string;
  monthlyExecutions: number | null;
  resetDay: number | null;
}): Promise<boolean> {
  const r = await query(
    `UPDATE n8n_connections SET plan_monthly_executions = $3, plan_reset_day = $4, updated_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [p.tenantId, p.connectionId, p.monthlyExecutions, p.resetDay],
  );
  return (r.rowCount ?? 0) > 0;
}
