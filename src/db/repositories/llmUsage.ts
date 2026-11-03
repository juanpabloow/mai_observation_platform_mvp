import { query, withTransaction } from '../client.js';
import type { LlmUsageExtraction } from '../../analytics/llmUsage.js';

/**
 * COSTOS DE IA — persistence + reads for `execution_llm_scans` / `execution_llm_usage`
 * (migration 1827). Every read is tenant-scoped; nothing here returns message content.
 */

export interface ExecutionForLlmUsage {
  id: string;
  tenant_id: string;
  n8n_connection_id: string;
  n8n_workflow_id: string;
  started_at: Date;
  raw_data: unknown;
}

const COLUMNS = 'e.id, e.tenant_id, e.n8n_connection_id, e.n8n_workflow_id, e.started_at, e.raw_data';

export async function getExecutionsForLlmUsageByIds(params: {
  tenantId: string;
  ids: string[];
}): Promise<ExecutionForLlmUsage[]> {
  if (params.ids.length === 0) return [];
  const r = await query<ExecutionForLlmUsage>(
    `SELECT ${COLUMNS} FROM executions e WHERE e.tenant_id = $1 AND e.id = ANY($2::uuid[])`,
    [params.tenantId, params.ids],
  );
  return r.rows;
}

/**
 * One keyset page (id ASC, every tenant) for the backfill. `onlyUnscanned` skips executions that
 * already have a scan row, so an interrupted backfill resumes where it stopped.
 */
export async function listExecutionsForLlmUsagePage(params: {
  afterId: string | null;
  limit: number;
  onlyUnscanned: boolean;
}): Promise<ExecutionForLlmUsage[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  if (params.afterId) {
    values.push(params.afterId);
    where.push(`e.id > $${values.length}::uuid`);
  }
  if (params.onlyUnscanned) {
    where.push('NOT EXISTS (SELECT 1 FROM execution_llm_scans s WHERE s.execution_id = e.id)');
  }
  values.push(params.limit);
  const r = await query<ExecutionForLlmUsage>(
    `SELECT ${COLUMNS} FROM executions e
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY e.id ASC
      LIMIT $${values.length}`,
    values,
  );
  return r.rows;
}

/** Replace the execution's derived usage atomically (idempotent: re-running yields the same rows). */
export async function persistExecutionLlmUsage(
  execution: Omit<ExecutionForLlmUsage, 'raw_data'>,
  extraction: LlmUsageExtraction,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO execution_llm_scans (execution_id, tenant_id, has_run_data, llm_calls)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (execution_id) DO UPDATE
         SET has_run_data = EXCLUDED.has_run_data, llm_calls = EXCLUDED.llm_calls, scanned_at = now()`,
      [execution.id, execution.tenant_id, extraction.hasRunData, extraction.calls],
    );
    await client.query('DELETE FROM execution_llm_usage WHERE execution_id = $1', [execution.id]);
    for (const g of extraction.groups) {
      await client.query(
        `INSERT INTO execution_llm_usage
           (tenant_id, execution_id, n8n_connection_id, n8n_workflow_id, started_at,
            model, usage_source, calls, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [execution.tenant_id, execution.id, execution.n8n_connection_id, execution.n8n_workflow_id,
          execution.started_at, g.model, g.source, g.calls, g.inputTokens, g.outputTokens],
      );
    }
  });
}

// ── Reads for the screen ───────────────────────────────────────────────────────────────────

export interface AiCostPeriod {
  tenantId: string;
  from: Date;
  to: Date;
  /** IANA zone the per-day buckets are cut in. */
  timeZone: string;
}

export interface AiUsageRow {
  client_id: string | null;
  client_name: string | null;
  n8n_workflow_id: string;
  workflow_name: string | null;
  model: string | null;
  usage_source: 'provider' | 'estimate';
  day: string;
  executions: number;
  calls: number;
  input_tokens: number;
  output_tokens: number;
}

/** Usage in the period, grouped by client × workflow × model × source × local day. */
export async function listAiUsageRows(p: AiCostPeriod): Promise<AiUsageRow[]> {
  const r = await query<AiUsageRow>(
    `SELECT w.client_id, c.name AS client_name, u.n8n_workflow_id,
            coalesce(w.name, max(e.workflow_name)) AS workflow_name,
            u.model, u.usage_source,
            to_char((u.started_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day,
            count(DISTINCT u.execution_id)::int AS executions,
            sum(u.calls)::int AS calls,
            sum(u.input_tokens)::float8 AS input_tokens,
            sum(u.output_tokens)::float8 AS output_tokens
       FROM execution_llm_usage u
       JOIN executions e ON e.id = u.execution_id
       LEFT JOIN workflows w
         ON w.tenant_id = u.tenant_id AND w.n8n_connection_id = u.n8n_connection_id
        AND w.n8n_workflow_id = u.n8n_workflow_id
       LEFT JOIN clients c ON c.id = w.client_id AND c.tenant_id = u.tenant_id
      WHERE u.tenant_id = $1 AND u.started_at >= $2 AND u.started_at < $3
      GROUP BY w.client_id, c.name, u.n8n_workflow_id, w.name, u.model, u.usage_source, 7`,
    [p.tenantId, p.from, p.to, p.timeZone],
  );
  return r.rows;
}

export interface AiCoverageRow {
  n8n_workflow_id: string;
  total: number;
  scanned: number;
  without_data: number;
}

/**
 * Executions of the period of the workflows that have EVER called a model: how many were read
 * and how many n8n kept no data for. Those are unknown, not zero.
 */
export async function listAiCoverage(p: AiCostPeriod): Promise<AiCoverageRow[]> {
  const r = await query<AiCoverageRow>(
    `SELECT e.n8n_workflow_id,
            count(*)::int AS total,
            count(s.execution_id)::int AS scanned,
            count(*) FILTER (WHERE s.execution_id IS NOT NULL AND NOT s.has_run_data)::int AS without_data
       FROM executions e
       LEFT JOIN execution_llm_scans s ON s.execution_id = e.id
      WHERE e.tenant_id = $1 AND e.started_at >= $2 AND e.started_at < $3
        AND EXISTS (SELECT 1 FROM execution_llm_usage x
                     WHERE x.tenant_id = e.tenant_id AND x.n8n_workflow_id = e.n8n_workflow_id)
      GROUP BY e.n8n_workflow_id`,
    [p.tenantId, p.from, p.to],
  );
  return r.rows;
}

export interface AiClientActivityRow {
  client_id: string;
  conversations: number;
  bot_appointments: number;
}

/** Per client: conversations with a customer message, and appointments the bot booked. */
export async function listAiClientActivity(p: AiCostPeriod): Promise<AiClientActivityRow[]> {
  const r = await query<AiClientActivityRow>(
    `WITH conv AS (
       SELECT w.client_id, count(DISTINCT m.conversation_id)::int AS n
         FROM handoff_messages m
         JOIN conversations cv ON cv.id = m.conversation_id
         JOIN workflows w ON w.tenant_id = cv.tenant_id AND w.n8n_workflow_id = cv.n8n_workflow_id
        WHERE m.tenant_id = $1 AND m.sender = 'user' AND m.created_at >= $2 AND m.created_at < $3
          AND w.client_id IS NOT NULL
        GROUP BY w.client_id
     ), appt AS (
       SELECT client_id, count(*)::int AS n
         FROM appointments
        WHERE tenant_id = $1 AND origin = 'n8n' AND created_at >= $2 AND created_at < $3
        GROUP BY client_id
     )
     SELECT coalesce(conv.client_id, appt.client_id) AS client_id,
            coalesce(conv.n, 0) AS conversations, coalesce(appt.n, 0) AS bot_appointments
       FROM conv FULL JOIN appt ON appt.client_id = conv.client_id`,
    [p.tenantId, p.from, p.to],
  );
  return r.rows;
}

export interface AiMeetingsRow {
  client_id: string;
  client_name: string | null;
  model: string;
  analyses: number;
  input_tokens: number;
  output_tokens: number;
  /** Sum of the stored estimates; null when none of the rows had a price. */
  cost_usd: number | null;
  /** Rows with tokens but no stored cost (model without a price). */
  unpriced: number;
}

/** Meeting analyses (the platform's own OpenAI calls, with the provider's real token counts). */
export async function listAiMeetingRows(p: AiCostPeriod): Promise<AiMeetingsRow[]> {
  const r = await query<AiMeetingsRow>(
    `SELECT a.client_id, c.name AS client_name, coalesce(a.model_returned, a.model) AS model,
            count(*)::int AS analyses,
            sum(a.input_tokens)::float8 AS input_tokens,
            sum(a.output_tokens)::float8 AS output_tokens,
            sum(a.cost_usd)::float8 AS cost_usd,
            count(*) FILTER (WHERE a.cost_usd IS NULL AND (a.input_tokens + a.output_tokens) > 0)::int AS unpriced
       FROM meeting_analyses a
       LEFT JOIN clients c ON c.id = a.client_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.created_at >= $2 AND a.created_at < $3
        AND (a.input_tokens + a.output_tokens) > 0
      GROUP BY a.client_id, c.name, 3`,
    [p.tenantId, p.from, p.to],
  );
  return r.rows;
}
