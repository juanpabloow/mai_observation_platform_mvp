import { query } from '../client.js';

/**
 * Read-only aggregate queries for dashboards. Part of the shared data-access
 * layer (used by the web app); the ingestion worker does not depend on these.
 */

/** Number of executions stored for a tenant. */
export async function countExecutionsForTenant(tenantId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM executions WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Number of active n8n connections for a tenant. */
export async function countActiveConnectionsForTenant(tenantId: string): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM n8n_connections WHERE tenant_id = $1 AND is_active = true`,
    [tenantId],
  );
  return Number(result.rows[0]?.count ?? 0);
}
