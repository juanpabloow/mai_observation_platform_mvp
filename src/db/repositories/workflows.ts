import { query } from '../client.js';
import type { WorkflowRow } from '../types.js';

/** Input for upserting a workflow synced from n8n. */
export interface WorkflowUpsert {
  tenant_id: string;
  n8n_connection_id: string;
  n8n_workflow_id: string;
  name?: string | null;
  active?: boolean | null;
  /** Client a NEWLY-discovered workflow lands in (the tenant's default client).
   * Ignored for already-existing workflows — their assignment is preserved. */
  client_id: string;
}

const UPSERT_COLUMNS = [
  'tenant_id',
  'n8n_connection_id',
  'n8n_workflow_id',
  'name',
  'active',
  'client_id',
] as const;

/**
 * Upsert workflows synced from n8n. A newly-discovered workflow is inserted into
 * the provided client_id (the tenant's DEFAULT client, so client_id is never
 * null). On conflict (same connection + workflow id) it updates name/active/
 * last_synced_at but LEAVES client_id UNTOUCHED — workflow→client assignment is
 * managed by the platform, never overwritten by a sync. Returns rows affected.
 */
export async function upsertWorkflows(workflows: WorkflowUpsert[]): Promise<number> {
  if (workflows.length === 0) {
    return 0;
  }

  const params: unknown[] = [];
  const rowsSql: string[] = [];
  let p = 1;

  for (const w of workflows) {
    const placeholders = UPSERT_COLUMNS.map(() => `$${p++}`);
    // last_synced_at is set with now() (not a bound param).
    rowsSql.push(`(${placeholders.join(', ')}, now())`);
    params.push(
      w.tenant_id,
      w.n8n_connection_id,
      w.n8n_workflow_id,
      w.name ?? null,
      w.active ?? null,
      w.client_id,
    );
  }

  const sql = `INSERT INTO workflows (${UPSERT_COLUMNS.join(', ')}, last_synced_at)
     VALUES ${rowsSql.join(', ')}
     ON CONFLICT (n8n_connection_id, n8n_workflow_id) DO UPDATE SET
       name = EXCLUDED.name,
       active = EXCLUDED.active,
       last_synced_at = now(),
       updated_at = now()`;

  const result = await query(sql, params);
  return result.rowCount ?? 0;
}

/** List workflows for a connection, newest sync first. */
export async function listWorkflowsByConnection(
  connectionId: string,
): Promise<WorkflowRow[]> {
  const result = await query<WorkflowRow>(
    `SELECT * FROM workflows WHERE n8n_connection_id = $1 ORDER BY name ASC`,
    [connectionId],
  );
  return result.rows;
}

/** A workflow option for the filter dropdown (distinct workflow ids per tenant). */
export interface WorkflowOption {
  n8n_workflow_id: string;
  name: string | null;
}

/** Distinct workflows for a tenant, for the filter dropdown (ordered by name). */
export async function listWorkflowsForTenant(tenantId: string): Promise<WorkflowOption[]> {
  const result = await query<WorkflowOption>(
    `SELECT n8n_workflow_id, name
       FROM (
         SELECT DISTINCT ON (n8n_workflow_id) n8n_workflow_id, name
           FROM workflows
          WHERE tenant_id = $1
          ORDER BY n8n_workflow_id, name
       ) distinct_workflows
      ORDER BY name NULLS LAST, n8n_workflow_id`,
    [tenantId],
  );
  return result.rows;
}

/** A workflow summary for the picker: distinct workflow + active + execution count. */
export interface WorkflowSummary {
  n8n_workflow_id: string;
  name: string | null;
  active: boolean | null;
  execution_count: number;
}

/**
 * Distinct workflows for a tenant with their execution counts, for the workflow
 * picker. One GROUP BY scan over the tenant's executions (cheap for the picker;
 * the workflow list is small).
 */
export async function listWorkflowsForTenantWithCounts(
  tenantId: string,
): Promise<WorkflowSummary[]> {
  const result = await query<WorkflowSummary>(
    `WITH distinct_workflows AS (
       SELECT DISTINCT ON (n8n_workflow_id) n8n_workflow_id, name, active
         FROM workflows
        WHERE tenant_id = $1
        ORDER BY n8n_workflow_id, name
     ),
     execution_counts AS (
       SELECT n8n_workflow_id, count(*) AS c
         FROM executions
        WHERE tenant_id = $1
        GROUP BY n8n_workflow_id
     )
     SELECT dw.n8n_workflow_id,
            dw.name,
            dw.active,
            COALESCE(ec.c, 0)::int AS execution_count
       FROM distinct_workflows dw
       LEFT JOIN execution_counts ec USING (n8n_workflow_id)
      ORDER BY dw.name NULLS LAST, dw.n8n_workflow_id`,
    [tenantId],
  );
  return result.rows;
}

/**
 * Resolve an n8n workflow id to its workflow row for a tenant (always
 * tenant-scoped). Returns null if not found / not this tenant. If the same n8n
 * id exists under multiple connections, returns the most recently synced.
 */
export async function getWorkflowByN8nId(params: {
  tenantId: string;
  n8nWorkflowId: string;
}): Promise<WorkflowRow | null> {
  const { tenantId, n8nWorkflowId } = params;
  const result = await query<WorkflowRow>(
    `SELECT * FROM workflows
      WHERE tenant_id = $1 AND n8n_workflow_id = $2
      ORDER BY last_synced_at DESC NULLS LAST
      LIMIT 1`,
    [tenantId, n8nWorkflowId],
  );
  return result.rows[0] ?? null;
}
