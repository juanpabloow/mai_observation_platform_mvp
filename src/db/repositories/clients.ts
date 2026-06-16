import { pool, query } from '../client.js';

/**
 * `clients` are platform-managed logical groups of workflows within a tenant
 * (NOT n8n connections — those live in n8nConnections.ts). Every workflow belongs
 * to exactly one client; each tenant has exactly one `is_default` client that is
 * the home for ungrouped/auto-synced workflows.
 */
export interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  is_default: boolean;
  logo_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ClientWithCount extends ClientRow {
  /** How many workflows this client owns. */
  workflow_count: number;
}

const CLIENT_COLUMNS = 'id, tenant_id, name, is_default, logo_url, created_at, updated_at';

/** The tenant's default client (home for ungrouped workflows), or null. */
export async function getDefaultClientForTenant(tenantId: string): Promise<ClientRow | null> {
  const r = await query<ClientRow>(
    `SELECT ${CLIENT_COLUMNS} FROM clients WHERE tenant_id = $1 AND is_default = true LIMIT 1`,
    [tenantId],
  );
  return r.rows[0] ?? null;
}

/** All clients for a tenant with their workflow counts (default first, then name). */
export async function listClientsForTenant(tenantId: string): Promise<ClientWithCount[]> {
  const r = await query<ClientWithCount>(
    `SELECT c.id, c.tenant_id, c.name, c.is_default, c.logo_url, c.created_at, c.updated_at,
            count(w.id)::int AS workflow_count
       FROM clients c
       LEFT JOIN workflows w ON w.client_id = c.id
      WHERE c.tenant_id = $1
      GROUP BY c.id
      ORDER BY c.is_default DESC, lower(c.name)`,
    [tenantId],
  );
  return r.rows;
}

/** Create a new NON-default client for a tenant. */
export async function createClient(tenantId: string, name: string): Promise<ClientRow> {
  const r = await query<ClientRow>(
    `INSERT INTO clients (tenant_id, name) VALUES ($1, $2) RETURNING ${CLIENT_COLUMNS}`,
    [tenantId, name],
  );
  return r.rows[0];
}

/** Rename a client (tenant-scoped). Returns true if a row was updated. */
export async function renameClient(params: {
  tenantId: string;
  clientId: string;
  name: string;
}): Promise<boolean> {
  const r = await query(
    `UPDATE clients SET name = $3, updated_at = now() WHERE id = $2 AND tenant_id = $1`,
    [params.tenantId, params.clientId, params.name],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Assign a workflow to a client. BOTH the workflow AND the target client are
 * validated to belong to `tenantId`, so a cross-tenant id can never move data.
 * Returns true iff the workflow was (re)assigned.
 */
export async function assignWorkflowToClient(params: {
  tenantId: string;
  workflowId: string;
  clientId: string;
}): Promise<boolean> {
  const r = await query(
    `UPDATE workflows w
        SET client_id = $3, updated_at = now()
      WHERE w.id = $2
        AND w.tenant_id = $1
        AND EXISTS (SELECT 1 FROM clients c WHERE c.id = $3 AND c.tenant_id = $1)`,
    [params.tenantId, params.workflowId, params.clientId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Delete a NON-default client. Its workflows are first reassigned to the tenant's
 * default client (never orphaned or deleted); the default client itself cannot be
 * deleted. Atomic. Returns 'deleted' | 'not_found' (not this tenant's) |
 * 'is_default' (refused).
 */
export async function deleteClient(params: {
  tenantId: string;
  clientId: string;
}): Promise<'deleted' | 'not_found' | 'is_default'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await client.query<{ is_default: boolean }>(
      `SELECT is_default FROM clients WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [params.clientId, params.tenantId],
    );
    if (target.rows.length === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    if (target.rows[0].is_default) {
      await client.query('ROLLBACK');
      return 'is_default';
    }
    const def = await client.query<{ id: string }>(
      `SELECT id FROM clients WHERE tenant_id = $1 AND is_default = true LIMIT 1`,
      [params.tenantId],
    );
    const defaultId = def.rows[0]?.id;
    if (!defaultId) {
      await client.query('ROLLBACK');
      throw new Error('tenant has no default client');
    }
    await client.query(
      `UPDATE workflows SET client_id = $1, updated_at = now() WHERE client_id = $2 AND tenant_id = $3`,
      [defaultId, params.clientId, params.tenantId],
    );
    await client.query(`DELETE FROM clients WHERE id = $1 AND tenant_id = $2`, [
      params.clientId,
      params.tenantId,
    ]);
    await client.query('COMMIT');
    return 'deleted';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
