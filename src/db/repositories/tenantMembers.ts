import { pool, query } from '../client.js';

/** A row linking a Better Auth user to a tenant with a role. */
export interface TenantMemberRow {
  id: string;
  tenant_id: string;
  user_id: string;
  role: string;
  created_at: Date;
}

/**
 * The tenant for a user (the chokepoint lookup behind getCurrentTenantId).
 * Returns null when the user has no membership. Deterministic when a user has
 * more than one membership (oldest first) — only one is expected for now.
 */
export async function getTenantIdForUser(userId: string): Promise<string | null> {
  const result = await query<{ tenant_id: string }>(
    `SELECT tenant_id FROM tenant_members
      WHERE user_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId],
  );
  return result.rows[0]?.tenant_id ?? null;
}

/**
 * Create a brand-new tenant AND its owner membership in ONE transaction — both
 * or neither, so we never produce a tenant with no owner. Returns the tenant id.
 */
export async function createTenantWithOwner(params: {
  userId: string;
  tenantName: string;
}): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await client.query<{ id: string }>(
      `INSERT INTO tenants (name) VALUES ($1) RETURNING id`,
      [params.tenantName],
    );
    const tenantId = tenant.rows[0].id;
    await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [tenantId, params.userId],
    );
    // Every tenant is born with exactly one default client (its home for
    // ungrouped/auto-synced workflows). Same transaction → a tenant never exists
    // without a default client.
    await client.query(
      `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, true)`,
      [tenantId, params.tenantName],
    );
    await client.query('COMMIT');
    return tenantId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Idempotent provisioning: if the user already belongs to a tenant, return it;
 * otherwise create a fresh tenant + owner membership. Safe to call on every user
 * creation — a returning/duplicate call never makes a second tenant.
 */
export async function ensureTenantForUser(params: {
  userId: string;
  tenantName: string;
}): Promise<string> {
  const existing = await getTenantIdForUser(params.userId);
  if (existing) return existing;
  return createTenantWithOwner(params);
}

/**
 * Attach a user to an EXISTING tenant as owner (idempotent). Used by the founder
 * link to put the founder on the pre-existing MAI tenant.
 */
export async function linkUserToTenantAsOwner(params: {
  userId: string;
  tenantId: string;
}): Promise<void> {
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role)
     VALUES ($1, $2, 'owner')
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = 'owner'`,
    [params.tenantId, params.userId],
  );
}

/** Delete a Better Auth user by id (cascades account/session/membership). Used
 * to compensate when post-signup tenant provisioning fails. */
export async function deleteAuthUserById(userId: string): Promise<void> {
  await query(`DELETE FROM "user" WHERE id = $1`, [userId]);
}

/** Look up a Better Auth user id by email (for the founder-link CLI). */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const result = await query<{ id: string }>(`SELECT id FROM "user" WHERE email = $1`, [email]);
  return result.rows[0]?.id ?? null;
}

/** All tenant memberships for a user (for the founder-link cleanup). */
export async function listMembershipsForUser(userId: string): Promise<TenantMemberRow[]> {
  const result = await query<TenantMemberRow>(
    `SELECT id, tenant_id, user_id, role, created_at FROM tenant_members WHERE user_id = $1`,
    [userId],
  );
  return result.rows;
}
