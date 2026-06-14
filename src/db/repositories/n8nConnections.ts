import { firstRowOrThrow, query } from '../client.js';
import type { N8nConnectionRow } from '../types.js';

export interface InsertConnectionInput {
  tenant_id: string;
  name: string;
  n8n_base_url: string;
  n8n_api_key_encrypted: string;
  is_active?: boolean;
}

/** Insert a new n8n connection and return the created row. */
export async function insertConnection(
  input: InsertConnectionInput,
): Promise<N8nConnectionRow> {
  const result = await query<N8nConnectionRow>(
    `INSERT INTO n8n_connections (tenant_id, name, n8n_base_url, n8n_api_key_encrypted, is_active)
     VALUES ($1, $2, $3, $4, COALESCE($5, true))
     RETURNING *`,
    [
      input.tenant_id,
      input.name,
      input.n8n_base_url,
      input.n8n_api_key_encrypted,
      input.is_active ?? null,
    ],
  );
  return firstRowOrThrow(result, 'insertConnection');
}

/**
 * A connection as shown in the UI. Deliberately EXCLUDES
 * n8n_api_key_encrypted so the key never leaves the DB layer toward the client.
 */
export interface ConnectionSummary {
  id: string;
  name: string;
  n8n_base_url: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** List a tenant's connections for display (NEVER includes the API key). */
export async function listConnectionsForTenant(tenantId: string): Promise<ConnectionSummary[]> {
  const result = await query<ConnectionSummary>(
    `SELECT id, name, n8n_base_url, is_active, created_at, updated_at
       FROM n8n_connections
      WHERE tenant_id = $1
      ORDER BY created_at ASC`,
    [tenantId],
  );
  return result.rows;
}

/** Activate/deactivate a connection (tenant-scoped). Deactivating stops the
 * worker from polling it; it does NOT delete the connection or any domain data.
 * Returns true if a row was updated. */
export async function setConnectionActiveForTenant(params: {
  tenantId: string;
  id: string;
  isActive: boolean;
}): Promise<boolean> {
  const result = await query(
    `UPDATE n8n_connections SET is_active = $3, updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [params.id, params.tenantId, params.isActive],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Fetch a single connection by id, or null if it does not exist. */
export async function getConnectionById(id: string): Promise<N8nConnectionRow | null> {
  const result = await query<N8nConnectionRow>(
    `SELECT * FROM n8n_connections WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** List all active connections (across tenants), oldest first — what the worker polls. */
export async function listActiveConnections(): Promise<N8nConnectionRow[]> {
  const result = await query<N8nConnectionRow>(
    `SELECT * FROM n8n_connections WHERE is_active = true ORDER BY created_at ASC`,
  );
  return result.rows;
}

export interface UpsertConnectionByNameInput {
  tenant_id: string;
  name: string;
  n8n_base_url: string;
  n8n_api_key_encrypted: string;
}

/**
 * Insert a connection, or update its details if one with the same name already
 * exists for the tenant. Idempotent on (tenant_id, name). Single statement via
 * writable CTEs so it returns exactly one row.
 */
export async function upsertConnectionByName(
  input: UpsertConnectionByNameInput,
): Promise<N8nConnectionRow> {
  const result = await query<N8nConnectionRow>(
    `WITH updated AS (
       UPDATE n8n_connections
          SET n8n_base_url = $3,
              n8n_api_key_encrypted = $4,
              is_active = true,
              updated_at = now()
        WHERE tenant_id = $1 AND name = $2
        RETURNING *
     ), inserted AS (
       INSERT INTO n8n_connections (tenant_id, name, n8n_base_url, n8n_api_key_encrypted)
       SELECT $1, $2, $3, $4
        WHERE NOT EXISTS (SELECT 1 FROM updated)
        RETURNING *
     )
     SELECT * FROM updated
     UNION ALL
     SELECT * FROM inserted`,
    [input.tenant_id, input.name, input.n8n_base_url, input.n8n_api_key_encrypted],
  );
  return firstRowOrThrow(result, 'upsertConnectionByName');
}

/** Bump a connection's updated_at to now(); returns the row, or null if missing. */
export async function touchConnection(id: string): Promise<N8nConnectionRow | null> {
  const result = await query<N8nConnectionRow>(
    `UPDATE n8n_connections SET updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] ?? null;
}
