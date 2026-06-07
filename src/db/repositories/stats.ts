import { query } from '../client.js';

/**
 * Read-only aggregate queries for dashboards. Part of the shared data-access
 * layer (used by the web app); the ingestion worker does not depend on these.
 */

/** Total number of executions stored across all clients. */
export async function countAllExecutions(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM executions`,
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Number of clients currently marked active. */
export async function countActiveClients(): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM clients WHERE is_active = true`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
