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

/** A user's membership scope (RBAC): tenant + role + the one client a 'member'
 * is restricted to (NULL for owner/admin). The read behind getAccessScope(). */
export interface MembershipScopeRow {
  tenant_id: string;
  role: string;
  member_client_id: string | null;
}

/**
 * The current user's membership with its role + per-member client scope — the
 * read behind the web app's getAccessScope() authority. Oldest membership first
 * (matches getTenantIdForUser, so both resolve the SAME row); null when none.
 */
export async function getMembershipForUser(userId: string): Promise<MembershipScopeRow | null> {
  const result = await query<MembershipScopeRow>(
    `SELECT tenant_id, role, member_client_id FROM tenant_members
      WHERE user_id = $1
      ORDER BY created_at ASC
      LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Set a user's role within a tenant (used by the RBAC simulation/admin script;
 * RBAC-3 will add the real UI). Writes role + member_client_id in ONE UPDATE so
 * the role↔client invariant never transiently breaks: a 'member' REQUIRES a
 * memberClientId (validated same-tenant by the composite FK + the DB CHECK);
 * owner/admin force it to NULL. Returns rows affected (0 = no such membership).
 */
export async function setMembershipRole(params: {
  tenantId: string;
  userId: string;
  role: 'owner' | 'admin' | 'member';
  memberClientId?: string | null;
}): Promise<number> {
  const memberClientId = params.role === 'member' ? (params.memberClientId ?? null) : null;
  if (params.role === 'member' && !memberClientId) {
    throw new Error("setMembershipRole: role='member' requires a memberClientId");
  }
  const result = await query(
    `UPDATE tenant_members
        SET role = $3, member_client_id = $4
      WHERE tenant_id = $1 AND user_id = $2`,
    [params.tenantId, params.userId, params.role, memberClientId],
  );
  return result.rowCount ?? 0;
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

/** A tenant member with the joined display fields the team UI needs. */
export interface MemberWithDetails {
  user_id: string;
  email: string;
  name: string | null;
  role: string;
  member_client_id: string | null;
  client_name: string | null;
  created_at: Date;
}

/**
 * All members of a tenant (RBAC-3 team list): joins the Better Auth user (email/
 * name) + the assigned client's name. Ordered owner → admins → members, then email.
 */
export async function listMembersForTenant(tenantId: string): Promise<MemberWithDetails[]> {
  const result = await query<MemberWithDetails>(
    `SELECT tm.user_id, u.email, u.name, tm.role, tm.member_client_id,
            c.name AS client_name, tm.created_at
       FROM tenant_members tm
       JOIN "user" u ON u.id = tm.user_id
       LEFT JOIN clients c ON c.id = tm.member_client_id
      WHERE tm.tenant_id = $1
      ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.email)`,
    [tenantId],
  );
  return result.rows;
}

/** A single member's role + client scope within a tenant (for action guards). */
export async function getMemberInTenant(
  tenantId: string,
  userId: string,
): Promise<{ role: string; member_client_id: string | null } | null> {
  const result = await query<{ role: string; member_client_id: string | null }>(
    `SELECT role, member_client_id FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Remove a member from a tenant. NEVER removes the OWNER row (the `role <> 'owner'`
 * guard is defense-in-depth on top of the action's checks — so a tenant can never
 * be left ownerless). Returns true iff a (non-owner) membership was deleted.
 */
export async function removeMemberFromTenant(params: {
  tenantId: string;
  userId: string;
}): Promise<boolean> {
  const result = await query(
    `DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2 AND role <> 'owner'`,
    [params.tenantId, params.userId],
  );
  return (result.rowCount ?? 0) > 0;
}
