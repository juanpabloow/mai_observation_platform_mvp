import { firstRowOrThrow, query } from '../client.js';
import type { TenantRow } from '../types.js';

/** Fetch a tenant by name, or null if none exists. */
export async function getTenantByName(name: string): Promise<TenantRow | null> {
  const result = await query<TenantRow>(`SELECT * FROM tenants WHERE name = $1`, [name]);
  return result.rows[0] ?? null;
}

/** Get the tenant with this name, creating it if it does not exist yet. */
export async function getOrCreateTenant(name: string): Promise<TenantRow> {
  const existing = await getTenantByName(name);
  if (existing) {
    return existing;
  }
  const result = await query<TenantRow>(
    `INSERT INTO tenants (name) VALUES ($1) RETURNING *`,
    [name],
  );
  return firstRowOrThrow(result, 'getOrCreateTenant');
}
