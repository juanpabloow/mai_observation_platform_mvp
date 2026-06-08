import { query } from '../client.js';

/**
 * Read-only aggregate queries for dashboards. Part of the shared data-access
 * layer (used by the web app); the ingestion worker does not depend on these.
 */

/** Total number of executions stored across all tenants. */
export async function countAllExecutions(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM executions`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Number of active n8n connections (the instances the worker polls). */
export async function countActiveConnections(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM n8n_connections WHERE is_active = true`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
