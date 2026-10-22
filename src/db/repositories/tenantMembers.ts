import { pool, query } from '../client.js';
import { insertAccessAuditEvent, type AccessAuditEvent } from './accessRoles.js';

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
  client_role: ClientRole | null;
  scheduling_site_id: string | null;
  scheduling_staff_id: string | null;
  /** Non-null iff client_role === 'custom': the business's custom role. */
  access_role_id: string | null;
  /** The custom role's stored permission keys (null for system roles / agency). */
  role_permissions: string[] | null;
  /** The custom role's name — null for system roles, or when the role doesn't resolve in
   *  this membership's tenant + client (the scope then fails closed). */
  access_role_name: string | null;
}

/**
 * The client-level role for a `member` (the people who work AT a client). NULL for
 * owner/admin (the agency). See web/lib/access.ts for what each grants.
 *   owner  → full control of THEIR client (incl. settings, custom fields, team, analytics);
 *   setter → works the chats + CRM: inbox, contacts, agenda + booking. NO analytics,
 *            executions or workflow internals. (Replaced the old generic "editor".)
 *   staff  → own agenda only (sees the whole site, books its own column).
 * Only `staff` carries a scheduling_site_id + scheduling_staff_id binding.
 */
export type ClientRole = 'owner' | 'setter' | 'staff' | 'custom';

/** The three protected system roles (a `custom` member's role lives in access_roles). */
export type SystemClientRole = Exclude<ClientRole, 'custom'>;

/**
 * The current user's membership with its role + per-member client scope — the
 * read behind the web app's getAccessScope() authority. Oldest membership first
 * (matches getTenantIdForUser, so both resolve the SAME row); null when none.
 */
export async function getMembershipForUser(userId: string): Promise<MembershipScopeRow | null> {
  const result = await query<MembershipScopeRow>(
    `SELECT tm.tenant_id, tm.role, tm.member_client_id, tm.client_role,
            tm.scheduling_site_id, tm.scheduling_staff_id, tm.access_role_id,
            CASE WHEN tm.access_role_id IS NULL THEN NULL ELSE
              COALESCE((SELECT array_agg(p.permission_key)
                          FROM access_roles r
                          JOIN access_role_permissions p ON p.role_id = r.id
                         WHERE r.id = tm.access_role_id
                           AND r.tenant_id = tm.tenant_id
                           AND r.client_id = tm.member_client_id), '{}')
            END AS role_permissions,
            (SELECT r.name FROM access_roles r
              WHERE r.id = tm.access_role_id
                AND r.tenant_id = tm.tenant_id
                AND r.client_id = tm.member_client_id) AS access_role_name
       FROM tenant_members tm
      WHERE tm.user_id = $1
      ORDER BY tm.created_at ASC
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
  /** Required-ish when role === 'member' (defaults to 'setter'). Only 'owner' | 'setter'
   *  here — a 'staff' login needs a site+staff binding, set via setMemberClientRole. */
  clientRole?: 'owner' | 'setter';
  /** Written in the same transaction as the change. */
  audit?: AccessAuditEvent;
}): Promise<number> {
  const memberClientId = params.role === 'member' ? (params.memberClientId ?? null) : null;
  const clientRole = params.role === 'member' ? (params.clientRole ?? 'setter') : null;
  if (params.role === 'member' && !memberClientId) {
    throw new Error("setMembershipRole: role='member' requires a memberClientId");
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE tenant_members
          SET role = $3, member_client_id = $4, client_role = $5,
              scheduling_site_id = NULL,
              scheduling_staff_id = NULL,
              access_role_id = NULL
        WHERE tenant_id = $1 AND user_id = $2`,
      [params.tenantId, params.userId, params.role, memberClientId, clientRole],
    );
    const n = result.rowCount ?? 0;
    if (n > 0 && params.audit) await insertAccessAuditEvent(params.audit, client);
    await client.query('COMMIT');
    return n;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** How many CLIENT OWNERS a client has — the last-owner guard reads this so the final
 *  Client Owner of a client can never be demoted or removed. */
export async function countClientOwners(tenantId: string, clientId: string): Promise<number> {
  const result = await query<{ n: string }>(
    `SELECT count(*)::int AS n FROM tenant_members
      WHERE tenant_id = $1 AND role = 'member'
        AND member_client_id = $2 AND client_role = 'owner'`,
    [tenantId, clientId],
  );
  return Number(result.rows[0]?.n ?? 0);
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
     ON CONFLICT (tenant_id, user_id) DO UPDATE SET
       role = 'owner',
       member_client_id = NULL,
       client_role = NULL,
       scheduling_site_id = NULL,
       scheduling_staff_id = NULL`,
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
  client_role: ClientRole | null;
  scheduling_site_id: string | null;
  scheduling_site_name: string | null;
  scheduling_staff_id: string | null;
  scheduling_staff_name: string | null;
  access_role_id: string | null;
  access_role_name: string | null;
  created_at: Date;
}

/**
 * All members of a tenant (RBAC-3 team list): joins the Better Auth user (email/
 * name) + the assigned client's name. Ordered owner → admins → members, then email.
 */
export async function listMembersForTenant(tenantId: string): Promise<MemberWithDetails[]> {
  const result = await query<MemberWithDetails>(
    `SELECT tm.user_id, u.email, u.name, tm.role, tm.member_client_id,
            c.name AS client_name, tm.client_role, tm.scheduling_site_id,
            s.name AS scheduling_site_name, tm.scheduling_staff_id,
            st.name AS scheduling_staff_name, tm.access_role_id,
            ar.name AS access_role_name, tm.created_at
       FROM tenant_members tm
       JOIN "user" u ON u.id = tm.user_id
       LEFT JOIN clients c ON c.id = tm.member_client_id
       LEFT JOIN sites s ON s.id = tm.scheduling_site_id AND s.tenant_id = tm.tenant_id
       LEFT JOIN staff st ON st.id = tm.scheduling_staff_id AND st.tenant_id = tm.tenant_id
       LEFT JOIN access_roles ar ON ar.id = tm.access_role_id AND ar.tenant_id = tm.tenant_id
      WHERE tm.tenant_id = $1
      ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, lower(u.email)`,
    [tenantId],
  );
  return result.rows;
}

/** Minimal, PII-free staff options for assigning scheduling logins. */
export interface SchedulingResourceOption {
  id: string;
  site_id: string;
  name: string;
}

export async function listSchedulingResourcesForClient(
  tenantId: string,
  clientId: string,
): Promise<SchedulingResourceOption[]> {
  const result = await query<SchedulingResourceOption>(
    `SELECT st.id, st.site_id, st.name
       FROM staff st
       JOIN sites si
         ON si.id = st.site_id AND si.tenant_id = st.tenant_id
      WHERE st.tenant_id = $1 AND si.client_id = $2
        AND st.active = true AND st.takes_bookings = true
      ORDER BY st.name`,
    [tenantId, clientId],
  );
  return result.rows;
}

/** A single member's role + client scope within a tenant (for action guards). */
export interface MemberInTenant {
  role: string;
  email: string | null;
  member_client_id: string | null;
  client_role: ClientRole | null;
  scheduling_site_id: string | null;
  scheduling_staff_id: string | null;
  access_role_id: string | null;
  /** The custom role's stored keys (null for system roles / agency). */
  role_permissions: string[] | null;
  access_role_name: string | null;
}

export async function getMemberInTenant(tenantId: string, userId: string): Promise<MemberInTenant | null> {
  const result = await query<MemberInTenant>(
    `SELECT tm.role, u.email, tm.member_client_id, tm.client_role, tm.scheduling_site_id,
            tm.scheduling_staff_id, tm.access_role_id,
            CASE WHEN tm.access_role_id IS NULL THEN NULL ELSE
              COALESCE((SELECT array_agg(p.permission_key) FROM access_role_permissions p
                         WHERE p.role_id = tm.access_role_id), '{}')
            END AS role_permissions,
            (SELECT r.name FROM access_roles r WHERE r.id = tm.access_role_id) AS access_role_name
       FROM tenant_members tm
       LEFT JOIN "user" u ON u.id = tm.user_id
      WHERE tm.tenant_id = $1 AND tm.user_id = $2`,
    [tenantId, userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Set a member's CLIENT ROLE within their client: a system role (owner | setter | staff)
 * or a business CUSTOM role (`custom` + accessRoleId). `staff` carries a site + staff
 * binding (both required); every other role clears it (they see the whole client).
 * Composite foreign keys enforce that the site belongs to the member's tenant/client, the
 * staff to that site, and a custom role to the member's tenant AND client. Scoped to
 * `role='member' AND member_client_id=clientId`, so it can never touch an owner/admin or a
 * member of another client. The audit event (when given) commits with the change.
 */
export async function setMemberClientRole(params: {
  tenantId: string;
  userId: string;
  clientId: string;
  clientRole: ClientRole;
  siteId?: string | null;
  staffId?: string | null;
  accessRoleId?: string | null;
  audit?: AccessAuditEvent;
}): Promise<number> {
  const siteId = params.clientRole === 'staff' ? (params.siteId ?? null) : null;
  const staffId = params.clientRole === 'staff' ? (params.staffId ?? null) : null;
  const accessRoleId = params.clientRole === 'custom' ? (params.accessRoleId ?? null) : null;
  if (params.clientRole === 'staff' && (!siteId || !staffId)) {
    throw new Error("setMemberClientRole: clientRole='staff' requires a site and a staff resource");
  }
  if (params.clientRole === 'custom' && !accessRoleId) {
    throw new Error("setMemberClientRole: clientRole='custom' requires an accessRoleId");
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE tenant_members
          SET client_role = $4,
              scheduling_site_id = $5,
              scheduling_staff_id = $6,
              access_role_id = $7
        WHERE tenant_id = $1 AND user_id = $2
          AND role = 'member' AND member_client_id = $3`,
      [params.tenantId, params.userId, params.clientId, params.clientRole, siteId, staffId, accessRoleId],
    );
    const n = result.rowCount ?? 0;
    if (n > 0 && params.audit) await insertAccessAuditEvent(params.audit, client);
    await client.query('COMMIT');
    return n;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Remove a member from a tenant. NEVER removes the OWNER row (the `role <> 'owner'`
 * guard is defense-in-depth on top of the action's checks — so a tenant can never
 * be left ownerless). Returns true iff a (non-owner) membership was deleted.
 */
export async function removeMemberFromTenant(params: {
  tenantId: string;
  userId: string;
  audit?: AccessAuditEvent;
}): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2 AND role <> 'owner'`,
      [params.tenantId, params.userId],
    );
    const removed = (result.rowCount ?? 0) > 0;
    if (removed && params.audit) await insertAccessAuditEvent(params.audit, client);
    await client.query('COMMIT');
    return removed;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
