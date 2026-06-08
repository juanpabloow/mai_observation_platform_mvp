import { query } from '../client.js';

/**
 * `clients` here are the NEW concept: platform-managed logical groups of
 * workflows (not n8n connections — those live in n8nConnections.ts).
 */

/** A client option for the filter dropdown. */
export interface ClientOption {
  id: string;
  name: string;
}

/** List a tenant's clients, ordered by name (for the filter dropdown). */
export async function listClientsForTenant(tenantId: string): Promise<ClientOption[]> {
  const result = await query<ClientOption>(
    `SELECT id, name FROM clients WHERE tenant_id = $1 ORDER BY name`,
    [tenantId],
  );
  return result.rows;
}
