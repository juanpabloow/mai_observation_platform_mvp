import { query } from '../client.js';
import type { WorkflowRow } from '../types.js';

/** Input for upserting a workflow synced from n8n. */
export interface WorkflowUpsert {
  tenant_id: string;
  n8n_connection_id: string;
  n8n_workflow_id: string;
  name?: string | null;
  active?: boolean | null;
}

const UPSERT_COLUMNS = [
  'tenant_id',
  'n8n_connection_id',
  'n8n_workflow_id',
  'name',
  'active',
] as const;

/**
 * Upsert workflows synced from n8n. On conflict (same connection + workflow id)
 * updates name/active/last_synced_at but LEAVES client_id untouched (assignment
 * is managed by the platform, not by sync). Returns the number of rows affected.
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
