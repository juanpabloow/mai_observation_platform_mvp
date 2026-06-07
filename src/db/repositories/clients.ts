import { firstRowOrThrow, query } from '../client.js';
import type { ClientRow } from '../types.js';

export interface InsertClientInput {
  name: string;
  n8n_base_url: string;
  n8n_api_key_encrypted: string;
  is_active?: boolean;
}

/** Insert a new client and return the created row. */
export async function insertClient(input: InsertClientInput): Promise<ClientRow> {
  const result = await query<ClientRow>(
    `INSERT INTO clients (name, n8n_base_url, n8n_api_key_encrypted, is_active)
     VALUES ($1, $2, $3, COALESCE($4, true))
     RETURNING *`,
    [input.name, input.n8n_base_url, input.n8n_api_key_encrypted, input.is_active ?? null],
  );
  return firstRowOrThrow(result, 'insertClient');
}

/** Fetch a single client by id, or null if it does not exist. */
export async function getClientById(id: string): Promise<ClientRow | null> {
  const result = await query<ClientRow>(`SELECT * FROM clients WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** List all active clients, oldest first. */
export async function listActiveClients(): Promise<ClientRow[]> {
  const result = await query<ClientRow>(
    `SELECT * FROM clients WHERE is_active = true ORDER BY created_at ASC`,
  );
  return result.rows;
}

export interface UpsertClientByNameInput {
  name: string;
  n8n_base_url: string;
  n8n_api_key_encrypted: string;
}

/**
 * Insert a client, or update its connection details if one with the same name
 * already exists. Idempotent on `name` (re-running won't create duplicates).
 * Done in a single statement via writable CTEs so it returns exactly one row.
 */
export async function upsertClientByName(input: UpsertClientByNameInput): Promise<ClientRow> {
  const result = await query<ClientRow>(
    `WITH updated AS (
       UPDATE clients
          SET n8n_base_url = $2,
              n8n_api_key_encrypted = $3,
              is_active = true,
              updated_at = now()
        WHERE name = $1
        RETURNING *
     ), inserted AS (
       INSERT INTO clients (name, n8n_base_url, n8n_api_key_encrypted)
       SELECT $1, $2, $3
        WHERE NOT EXISTS (SELECT 1 FROM updated)
        RETURNING *
     )
     SELECT * FROM updated
     UNION ALL
     SELECT * FROM inserted`,
    [input.name, input.n8n_base_url, input.n8n_api_key_encrypted],
  );
  return firstRowOrThrow(result, 'upsertClientByName');
}

/** Bump a client's updated_at to now(); returns the updated row, or null if missing. */
export async function touchClient(id: string): Promise<ClientRow | null> {
  const result = await query<ClientRow>(
    `UPDATE clients SET updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] ?? null;
}
