import { query } from '../client.js';

/** Input shape for inserting an execution. `raw_data` is any JSON-serialisable value. */
export interface NewExecution {
  tenant_id: string;
  n8n_connection_id: string;
  n8n_execution_id: string;
  n8n_workflow_id: string;
  workflow_name?: string | null;
  status: string;
  mode?: string | null;
  started_at: Date | string;
  stopped_at?: Date | string | null;
  duration_ms?: number | null;
  raw_data?: unknown;
}

// Column order used to build the multi-row INSERT. Only identifiers live in the
// SQL string; every value is bound as a $N parameter.
const INSERT_COLUMNS = [
  'tenant_id',
  'n8n_connection_id',
  'n8n_execution_id',
  'n8n_workflow_id',
  'workflow_name',
  'status',
  'mode',
  'started_at',
  'stopped_at',
  'duration_ms',
  'raw_data',
] as const;

/**
 * Insert many executions in one statement. Conflicts on
 * (n8n_connection_id, n8n_execution_id) are ignored (ON CONFLICT DO NOTHING) —
 * this is the idempotency guarantee for re-polling.
 *
 * @returns the number of rows actually inserted (excludes ignored conflicts).
 */
export async function upsertMany(executions: NewExecution[]): Promise<number> {
  if (executions.length === 0) {
    return 0;
  }

  const params: unknown[] = [];
  const rowsSql: string[] = [];
  let p = 1;

  for (const e of executions) {
    const placeholders = INSERT_COLUMNS.map(() => `$${p++}`);
    rowsSql.push(`(${placeholders.join(', ')})`);
    params.push(
      e.tenant_id,
      e.n8n_connection_id,
      e.n8n_execution_id,
      e.n8n_workflow_id,
      e.workflow_name ?? null,
      e.status,
      e.mode ?? null,
      e.started_at,
      e.stopped_at ?? null,
      e.duration_ms ?? null,
      // Serialise explicitly so arrays/objects always land as JSONB (pg would
      // otherwise treat a top-level JS array as a Postgres array literal).
      e.raw_data === undefined || e.raw_data === null ? null : JSON.stringify(e.raw_data),
    );
  }

  const sql = `INSERT INTO executions (${INSERT_COLUMNS.join(', ')})
     VALUES ${rowsSql.join(', ')}
     ON CONFLICT (n8n_connection_id, n8n_execution_id) DO NOTHING`;

  const result = await query(sql, params);
  return result.rowCount ?? 0;
}

/** Count executions stored for a given n8n connection (used for verification). */
export async function countByConnection(connectionId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM executions WHERE n8n_connection_id = $1`,
    [connectionId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** A row in the tenant-scoped executions list (joined to workflow + client). */
export interface ExecutionListItem {
  id: string;
  n8n_execution_id: string;
  status: string;
  mode: string | null;
  started_at: Date;
  stopped_at: Date | null;
  duration_ms: number | null;
  n8n_workflow_id: string;
  /** workflows.name, falling back to executions.workflow_name, then the raw id. */
  workflow_name: string;
  /** Assigned client's name, or null if the workflow is unassigned. */
  client_name: string | null;
}

export interface ListExecutionsPageParams {
  tenantId: string;
  limit: number;
  offset: number;
}

export interface ExecutionsPage {
  rows: ExecutionListItem[];
  total: number;
}

/**
 * Fetch one page of executions for a tenant, newest first. Resolves the workflow
 * name (and assigned client name) via LEFT JOINs; never loads more than `limit`
 * rows. `total` is the tenant's full execution count, for pagination.
 *
 * Backed by the (tenant_id, started_at DESC) index.
 */
export async function listExecutionsPage(
  params: ListExecutionsPageParams,
): Promise<ExecutionsPage> {
  const { tenantId, limit, offset } = params;

  const rowsPromise = query<ExecutionListItem>(
    `SELECT
       e.id,
       e.n8n_execution_id,
       e.status,
       e.mode,
       e.started_at,
       e.stopped_at,
       e.duration_ms,
       e.n8n_workflow_id,
       COALESCE(w.name, e.workflow_name, e.n8n_workflow_id) AS workflow_name,
       c.name AS client_name
     FROM executions e
     LEFT JOIN workflows w
       ON w.n8n_connection_id = e.n8n_connection_id
      AND w.n8n_workflow_id = e.n8n_workflow_id
     LEFT JOIN clients c ON c.id = w.client_id
     WHERE e.tenant_id = $1
     ORDER BY e.started_at DESC, e.n8n_execution_id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );

  const totalPromise = query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM executions WHERE tenant_id = $1`,
    [tenantId],
  );

  const [rowsResult, totalResult] = await Promise.all([rowsPromise, totalPromise]);

  return {
    rows: rowsResult.rows,
    total: Number(totalResult.rows[0]?.count ?? 0),
  };
}
