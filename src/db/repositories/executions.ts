import { query } from '../client.js';

/** Input shape for inserting an execution. `raw_data` is any JSON-serialisable value. */
export interface NewExecution {
  client_id: string;
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
  'client_id',
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
 * (client_id, n8n_execution_id) are ignored (ON CONFLICT DO NOTHING) — this is
 * the idempotency guarantee for re-polling.
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
      e.client_id,
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
     ON CONFLICT (client_id, n8n_execution_id) DO NOTHING`;

  const result = await query(sql, params);
  return result.rowCount ?? 0;
}

/** Count executions stored for a given client (used for verification). */
export async function countByClient(clientId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM executions WHERE client_id = $1`,
    [clientId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
