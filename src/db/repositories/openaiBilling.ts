import { query, withTransaction } from '../client.js';
import type { CostRow, ProjectRow, UsageRow } from '../../analytics/openaiBilling.js';

/**
 * COSTOS DE IA — OpenAI billing persistence (migration 1829). Tenant-scoped. The encrypted key is
 * read ONLY by the sync (getOpenAiKeyForSync); every read for the screen returns the hint only.
 */

export interface OpenAiConnectionStatus {
  key_hint: string;
  created_at: Date;
  last_synced_at: Date | null;
  last_sync_error: string | null;
}

export async function getOpenAiConnectionStatus(tenantId: string): Promise<OpenAiConnectionStatus | null> {
  const r = await query<OpenAiConnectionStatus>(
    `SELECT key_hint, created_at, last_synced_at, last_sync_error FROM openai_connections WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

export async function upsertOpenAiConnection(p: { tenantId: string; keyEncrypted: string; keyHint: string; userId: string | null }): Promise<void> {
  await query(
    `INSERT INTO openai_connections (tenant_id, admin_key_encrypted, key_hint, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET admin_key_encrypted = EXCLUDED.admin_key_encrypted, key_hint = EXCLUDED.key_hint,
           created_by_user_id = EXCLUDED.created_by_user_id, updated_at = now(),
           last_synced_at = NULL, last_attempt_at = NULL, last_sync_error = NULL`,
    [p.tenantId, p.keyEncrypted, p.keyHint, p.userId],
  );
}

export async function deleteOpenAiConnection(tenantId: string): Promise<boolean> {
  const r = await query(`DELETE FROM openai_connections WHERE tenant_id = $1`, [tenantId]);
  return (r.rowCount ?? 0) > 0;
}

/** For the sync only. */
export async function getOpenAiKeyForSync(tenantId: string): Promise<string | null> {
  const r = await query<{ admin_key_encrypted: string }>(`SELECT admin_key_encrypted FROM openai_connections WHERE tenant_id = $1`, [tenantId]);
  return r.rows[0]?.admin_key_encrypted ?? null;
}

/** Tenants whose last sync is older than `staleMs` (or never ran). */
export async function listOpenAiConnectionsDue(staleMs: number): Promise<string[]> {
  const r = await query<{ tenant_id: string }>(
    `SELECT tenant_id FROM openai_connections
      WHERE last_attempt_at IS NULL OR last_attempt_at < now() - ($1::bigint * interval '1 millisecond')`,
    [staleMs],
  );
  return r.rows.map((x) => x.tenant_id);
}

export async function recordOpenAiSync(tenantId: string, error: string | null): Promise<void> {
  await query(
    `UPDATE openai_connections
        SET last_sync_error = $2, last_attempt_at = now(),
            last_synced_at = CASE WHEN $2::text IS NULL THEN now() ELSE last_synced_at END
      WHERE tenant_id = $1`,
    [tenantId, error ? error.slice(0, 300) : null],
  );
}

/**
 * Replace the synced window [fromDay, toDay] atomically (OpenAI's numbers for recent days move),
 * and the project list (names change, projects get archived).
 */
export async function replaceOpenAiWindow(p: {
  tenantId: string;
  fromDay: string;
  toDay: string;
  costs: CostRow[];
  usage: UsageRow[];
  projects?: ProjectRow[];
}): Promise<void> {
  await withTransaction(async (client) => {
    if (p.projects) {
      await client.query(`DELETE FROM openai_projects WHERE tenant_id = $1`, [p.tenantId]);
      for (const pr of p.projects) {
        await client.query(
          `INSERT INTO openai_projects (tenant_id, project_id, name, status) VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, project_id) DO UPDATE SET name = EXCLUDED.name, status = EXCLUDED.status, synced_at = now()`,
          [p.tenantId, pr.projectId, pr.name, pr.status],
        );
      }
    }
    await client.query(`DELETE FROM openai_daily_costs WHERE tenant_id = $1 AND day BETWEEN $2 AND $3`, [p.tenantId, p.fromDay, p.toDay]);
    await client.query(`DELETE FROM openai_daily_usage WHERE tenant_id = $1 AND day BETWEEN $2 AND $3`, [p.tenantId, p.fromDay, p.toDay]);
    for (const c of p.costs) {
      await client.query(
        `INSERT INTO openai_daily_costs (tenant_id, day, project_id, line_item, amount_usd) VALUES ($1, $2, $3, $4, $5)`,
        [p.tenantId, c.day, c.projectId, c.lineItem, c.amountUsd],
      );
    }
    for (const u of p.usage) {
      await client.query(
        `INSERT INTO openai_daily_usage (tenant_id, day, project_id, model, requests, input_tokens, cached_input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [p.tenantId, u.day, u.projectId, u.model, u.requests, u.inputTokens, u.cachedInputTokens, u.outputTokens],
      );
    }
  });
}

export interface BilledDayRow {
  day: string;
  amount_usd: number;
}
export interface BilledModelRow {
  model: string;
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}
export interface BilledLineRow {
  line_item: string;
  amount_usd: number;
}

/** What OpenAI billed per UTC day in [fromDay, toDay]. */
export async function listBilledDays(tenantId: string, fromDay: string, toDay: string): Promise<BilledDayRow[]> {
  const r = await query<BilledDayRow>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, sum(amount_usd)::float8 AS amount_usd
       FROM openai_daily_costs WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
      GROUP BY day ORDER BY day`,
    [tenantId, fromDay, toDay],
  );
  return r.rows;
}

export async function listBilledLines(tenantId: string, fromDay: string, toDay: string): Promise<BilledLineRow[]> {
  const r = await query<BilledLineRow>(
    `SELECT line_item, sum(amount_usd)::float8 AS amount_usd
       FROM openai_daily_costs WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
      GROUP BY line_item ORDER BY 2 DESC`,
    [tenantId, fromDay, toDay],
  );
  return r.rows;
}

export async function listBilledModels(tenantId: string, fromDay: string, toDay: string): Promise<BilledModelRow[]> {
  const r = await query<BilledModelRow>(
    `SELECT model, sum(requests)::float8 AS requests, sum(input_tokens)::float8 AS input_tokens,
            sum(cached_input_tokens)::float8 AS cached_input_tokens, sum(output_tokens)::float8 AS output_tokens
       FROM openai_daily_usage WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
      GROUP BY model ORDER BY 2 DESC`,
    [tenantId, fromDay, toDay],
  );
  return r.rows;
}

export interface BilledDayProjectRow {
  day: string;
  project_id: string;
  amount_usd: number;
}

/** What OpenAI billed per UTC day × project in [fromDay, toDay] — the input of the split. */
export async function listBilledByDayProject(tenantId: string, fromDay: string, toDay: string): Promise<BilledDayProjectRow[]> {
  const r = await query<BilledDayProjectRow>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, project_id, sum(amount_usd)::float8 AS amount_usd
       FROM openai_daily_costs WHERE tenant_id = $1 AND day BETWEEN $2 AND $3
      GROUP BY day, project_id ORDER BY day`,
    [tenantId, fromDay, toDay],
  );
  return r.rows;
}

export interface OpenAiProjectView {
  project_id: string;
  name: string | null;
  status: string | null;
  /** The business it is assigned to, if any. */
  client_id: string | null;
}

/**
 * The organization's projects, plus any project that only appears in the stored costs (e.g.
 * deleted since), with the business each one is assigned to.
 */
export async function listOpenAiProjects(tenantId: string): Promise<OpenAiProjectView[]> {
  const r = await query<OpenAiProjectView>(
    `WITH ids AS (
       SELECT project_id FROM openai_projects WHERE tenant_id = $1
       UNION
       SELECT DISTINCT project_id FROM openai_daily_costs WHERE tenant_id = $1 AND project_id <> ''
     )
     SELECT ids.project_id, p.name, p.status, c.id AS client_id
       FROM ids
       LEFT JOIN openai_projects p ON p.tenant_id = $1 AND p.project_id = ids.project_id
       LEFT JOIN clients c ON c.tenant_id = $1 AND c.openai_project_id = ids.project_id
      ORDER BY coalesce(p.name, ids.project_id)`,
    [tenantId],
  );
  return r.rows;
}

/** Which business uses which OpenAI project (tenant-scoped). */
export async function listClientProjectMap(tenantId: string): Promise<Array<{ client_id: string; openai_project_id: string }>> {
  const r = await query<{ client_id: string; openai_project_id: string }>(
    `SELECT id AS client_id, openai_project_id FROM clients WHERE tenant_id = $1 AND openai_project_id IS NOT NULL`,
    [tenantId],
  );
  return r.rows;
}

/**
 * Assign an OpenAI project to a business (or clear it with null). The project moves off any
 * other business of the tenant first, so the one-project-one-business rule never blocks the
 * agency. Returns false if the business isn't this tenant's (or is the default client).
 */
export async function setClientOpenAiProject(p: { tenantId: string; clientId: string; projectId: string | null }): Promise<boolean> {
  return withTransaction(async (client) => {
    if (p.projectId) {
      await client.query(
        `UPDATE clients SET openai_project_id = NULL, updated_at = now()
          WHERE tenant_id = $1 AND openai_project_id = $2 AND id <> $3`,
        [p.tenantId, p.projectId, p.clientId],
      );
    }
    const r = await client.query(
      `UPDATE clients SET openai_project_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND NOT is_default`,
      [p.tenantId, p.clientId, p.projectId],
    );
    return (r.rowCount ?? 0) > 0;
  });
}
