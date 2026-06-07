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

/** Bump a client's updated_at to now(); returns the updated row, or null if missing. */
export async function touchClient(id: string): Promise<ClientRow | null> {
  const result = await query<ClientRow>(
    `UPDATE clients SET updated_at = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return result.rows[0] ?? null;
}
