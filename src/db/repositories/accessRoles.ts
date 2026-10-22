import type { PoolClient } from 'pg';
import { pool, query } from '../client.js';

/**
 * CUSTOM ACCESS ROLES + the ACCESS AUDIT TRAIL (migration 1816).
 *
 * A custom role belongs to ONE business (tenant_id + client_id) and is a name, a
 * description and a set of permission keys. This layer stores keys verbatim; WHICH keys
 * mean anything — and whether a caller may grant them — is decided in the web layer
 * (web/lib/permissions/*). Every read and write is scoped by (tenant_id, client_id), so a
 * role id from another tenant or business never resolves.
 *
 * Writes that change access run in ONE transaction together with their audit event: a
 * change without its trail (or a trail without its change) can't be committed.
 */

export interface AccessRoleRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  description: string;
  version: number;
  permissions: string[];
  member_count: number;
  pending_invite_count: number;
  created_at: Date;
  updated_at: Date;
  updated_by_email: string | null;
}

export type AccessAuditAction =
  | 'role.created'
  | 'role.updated'
  | 'role.deleted'
  | 'member.role_changed'
  | 'member.client_changed'
  | 'member.tenant_role_changed'
  | 'member.removed'
  | 'invitation.created'
  | 'invitation.revoked';

export interface AccessAuditEvent {
  tenantId: string;
  clientId: string | null;
  actorUserId: string;
  actorEmail?: string | null;
  action: AccessAuditAction;
  targetType: 'role' | 'member' | 'invitation';
  targetId: string;
  targetLabel?: string | null;
  changes: Record<string, unknown>;
}

export interface AccessAuditRow {
  id: string;
  action: AccessAuditAction;
  target_type: string;
  target_id: string;
  target_label: string | null;
  actor_email: string | null;
  changes: Record<string, unknown>;
  created_at: Date;
}

type Db = Pick<PoolClient, 'query'>;

async function inTransaction<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Insert one audit event (inside the caller's transaction when `db` is a client). */
export async function insertAccessAuditEvent(e: AccessAuditEvent, db: Db = pool): Promise<void> {
  await db.query(
    `INSERT INTO access_audit_events
       (tenant_id, client_id, actor_user_id, actor_email, action, target_type, target_id, target_label, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      e.tenantId,
      e.clientId,
      e.actorUserId,
      e.actorEmail ?? null,
      e.action,
      e.targetType,
      e.targetId,
      e.targetLabel ?? null,
      JSON.stringify(e.changes),
    ],
  );
}

const ROLE_SELECT = `
  SELECT r.id, r.tenant_id, r.client_id, r.name, r.description, r.version,
         r.created_at, r.updated_at, uu.email AS updated_by_email,
         COALESCE((SELECT array_agg(p.permission_key ORDER BY p.permission_key)
                     FROM access_role_permissions p WHERE p.role_id = r.id), '{}') AS permissions,
         (SELECT count(*)::int FROM tenant_members tm
           WHERE tm.access_role_id = r.id AND tm.tenant_id = r.tenant_id) AS member_count,
         (SELECT count(*)::int FROM invitations i
           WHERE i.access_role_id = r.id AND i.tenant_id = r.tenant_id
             AND i.status = 'pending' AND i.expires_at > now()) AS pending_invite_count
    FROM access_roles r
    LEFT JOIN "user" uu ON uu.id = r.updated_by`;

/** The custom roles of one business, name order. */
export async function listAccessRoles(tenantId: string, clientId: string): Promise<AccessRoleRow[]> {
  const result = await query<AccessRoleRow>(
    `${ROLE_SELECT} WHERE r.tenant_id = $1 AND r.client_id = $2 AND r.system_key IS NULL ORDER BY lower(r.name)`,
    [tenantId, clientId],
  );
  return result.rows;
}

/** One custom role of one business, or null (foreign tenant/business ids never resolve). */
export async function getAccessRole(tenantId: string, clientId: string, roleId: string): Promise<AccessRoleRow | null> {
  const result = await query<AccessRoleRow>(
    `${ROLE_SELECT} WHERE r.tenant_id = $1 AND r.client_id = $2 AND r.id = $3 AND r.system_key IS NULL`,
    [tenantId, clientId, roleId],
  );
  return result.rows[0] ?? null;
}

async function writePermissions(db: Db, roleId: string, keys: readonly string[]): Promise<void> {
  await db.query(`DELETE FROM access_role_permissions WHERE role_id = $1`, [roleId]);
  if (keys.length === 0) return;
  await db.query(
    `INSERT INTO access_role_permissions (role_id, permission_key)
     SELECT $1, k FROM unnest($2::text[]) AS k`,
    [roleId, [...new Set(keys)]],
  );
}

export type RoleWriteResult =
  | { ok: true; id: string; version: number }
  | { ok: false; reason: 'duplicate_name' | 'not_found' | 'stale' | 'in_use' };

/** Create a custom role + its permissions + the audit event, atomically. */
export async function createAccessRole(p: {
  tenantId: string;
  clientId: string;
  name: string;
  description: string;
  permissions: readonly string[];
  actorUserId: string;
  actorEmail: string | null;
  auditChanges: Record<string, unknown>;
}): Promise<RoleWriteResult> {
  try {
    return await inTransaction(async (db) => {
      const ins = await db.query<{ id: string; version: number }>(
        `INSERT INTO access_roles (tenant_id, client_id, name, description, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING id, version`,
        [p.tenantId, p.clientId, p.name.trim(), p.description.trim(), p.actorUserId],
      );
      const { id, version } = ins.rows[0];
      await writePermissions(db, id, p.permissions);
      await insertAccessAuditEvent(
        {
          tenantId: p.tenantId,
          clientId: p.clientId,
          actorUserId: p.actorUserId,
          actorEmail: p.actorEmail,
          action: 'role.created',
          targetType: 'role',
          targetId: id,
          targetLabel: p.name.trim(),
          changes: p.auditChanges,
        },
        db,
      );
      return { ok: true as const, id, version };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: 'duplicate_name' };
    throw err;
  }
}

/**
 * Update a custom role (name, description, permissions) under OPTIMISTIC CONCURRENCY: the
 * caller passes the `version` it edited; if someone saved in between, nothing is written
 * ('stale'). The row is locked for the check, the version is bumped, and the audit event is
 * written in the same transaction. `authorize` runs on the LOCKED current row so the
 * delegation check can't race a concurrent edit.
 */
export async function updateAccessRole(p: {
  tenantId: string;
  clientId: string;
  roleId: string;
  expectedVersion: number;
  name: string;
  description: string;
  permissions: readonly string[];
  actorUserId: string;
  actorEmail: string | null;
  authorize: (current: { permissions: string[]; name: string }) => { ok: true } | { ok: false; reason: 'forbidden' };
  auditChanges: (current: { permissions: string[]; name: string; description: string }) => Record<string, unknown>;
}): Promise<RoleWriteResult | { ok: false; reason: 'forbidden' }> {
  try {
    return await inTransaction(async (db) => {
      const cur = await db.query<{ version: number; name: string; description: string }>(
        `SELECT version, name, description FROM access_roles
          WHERE tenant_id = $1 AND client_id = $2 AND id = $3 AND system_key IS NULL FOR UPDATE`,
        [p.tenantId, p.clientId, p.roleId],
      );
      if (cur.rowCount === 0) return { ok: false as const, reason: 'not_found' as const };
      const perms = await db.query<{ permission_key: string }>(
        `SELECT permission_key FROM access_role_permissions WHERE role_id = $1 ORDER BY permission_key`,
        [p.roleId],
      );
      const current = { ...cur.rows[0], permissions: perms.rows.map((r) => r.permission_key) };
      const auth = p.authorize(current);
      if (!auth.ok) return { ok: false as const, reason: 'forbidden' as const };
      if (current.version !== p.expectedVersion) return { ok: false as const, reason: 'stale' as const };
      const upd = await db.query<{ version: number }>(
        `UPDATE access_roles
            SET name = $4, description = $5, version = version + 1, updated_by = $6, updated_at = now()
          WHERE tenant_id = $1 AND client_id = $2 AND id = $3
          RETURNING version`,
        [p.tenantId, p.clientId, p.roleId, p.name.trim(), p.description.trim(), p.actorUserId],
      );
      await writePermissions(db, p.roleId, p.permissions);
      await insertAccessAuditEvent(
        {
          tenantId: p.tenantId,
          clientId: p.clientId,
          actorUserId: p.actorUserId,
          actorEmail: p.actorEmail,
          action: 'role.updated',
          targetType: 'role',
          targetId: p.roleId,
          targetLabel: p.name.trim(),
          changes: p.auditChanges(current),
        },
        db,
      );
      return { ok: true as const, id: p.roleId, version: upd.rows[0].version };
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: 'duplicate_name' };
    throw err;
  }
}

/**
 * Delete a custom role — refused ('in_use') while any login holds it or any pending
 * invitation offers it (the FK refuses it too; this check gives the reason first).
 * Expired-but-pending invitations are revoked with it so they can't be accepted later.
 */
export async function deleteAccessRole(p: {
  tenantId: string;
  clientId: string;
  roleId: string;
  actorUserId: string;
  actorEmail: string | null;
  authorize: (current: { permissions: string[]; name: string }) => { ok: true } | { ok: false; reason: 'forbidden' };
}): Promise<RoleWriteResult | { ok: false; reason: 'forbidden' }> {
  return inTransaction(async (db) => {
    const cur = await db.query<{ name: string }>(
      `SELECT name FROM access_roles WHERE tenant_id = $1 AND client_id = $2 AND id = $3 AND system_key IS NULL FOR UPDATE`,
      [p.tenantId, p.clientId, p.roleId],
    );
    if (cur.rowCount === 0) return { ok: false as const, reason: 'not_found' as const };
    const perms = await db.query<{ permission_key: string }>(
      `SELECT permission_key FROM access_role_permissions WHERE role_id = $1 ORDER BY permission_key`,
      [p.roleId],
    );
    const current = { name: cur.rows[0].name, permissions: perms.rows.map((r) => r.permission_key) };
    if (!p.authorize(current).ok) return { ok: false as const, reason: 'forbidden' as const };
    const used = await db.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM tenant_members WHERE tenant_id = $1 AND access_role_id = $2)
             + (SELECT count(*) FROM invitations WHERE tenant_id = $1 AND access_role_id = $2
                  AND status = 'pending' AND expires_at > now()))::int AS n`,
      [p.tenantId, p.roleId],
    );
    if (used.rows[0].n > 0) return { ok: false as const, reason: 'in_use' as const };
    // Stale pending invitations (expired) and history rows stop pointing at the role.
    await db.query(
      `UPDATE invitations SET status = CASE WHEN status = 'pending' THEN 'revoked' ELSE status END,
              client_role = 'setter', access_role_id = NULL
        WHERE tenant_id = $1 AND access_role_id = $2`,
      [p.tenantId, p.roleId],
    );
    await db.query(`DELETE FROM access_roles WHERE tenant_id = $1 AND client_id = $2 AND id = $3`, [
      p.tenantId,
      p.clientId,
      p.roleId,
    ]);
    await insertAccessAuditEvent(
      {
        tenantId: p.tenantId,
        clientId: p.clientId,
        actorUserId: p.actorUserId,
        actorEmail: p.actorEmail,
        action: 'role.deleted',
        targetType: 'role',
        targetId: p.roleId,
        targetLabel: current.name,
        changes: { permissions: current.permissions },
      },
      db,
    );
    return { ok: true as const, id: p.roleId, version: 0 };
  });
}

// ── System-role overrides (one business's adjustment of Dueño / Recepción / Profesional) ──

export type SystemRoleKeyDb = 'owner' | 'setter' | 'staff';

export interface SystemRoleOverrideRow {
  system_key: SystemRoleKeyDb;
  version: number;
  permissions: string[];
  updated_at: Date;
  updated_by_email: string | null;
}

/** This business's overrides of the system roles (absent key = the code default). */
export async function listSystemRoleOverrides(tenantId: string, clientId: string): Promise<SystemRoleOverrideRow[]> {
  const result = await query<SystemRoleOverrideRow>(
    `SELECT r.system_key, r.version, r.updated_at, uu.email AS updated_by_email,
            COALESCE((SELECT array_agg(p.permission_key ORDER BY p.permission_key)
                        FROM access_role_permissions p WHERE p.role_id = r.id), '{}') AS permissions
       FROM access_roles r
       LEFT JOIN "user" uu ON uu.id = r.updated_by
      WHERE r.tenant_id = $1 AND r.client_id = $2 AND r.system_key IS NOT NULL`,
    [tenantId, clientId],
  );
  return result.rows;
}

/** One system role's override in one business, or null (= the default applies). */
export async function getSystemRoleOverride(tenantId: string, clientId: string, systemKey: SystemRoleKeyDb): Promise<string[] | null> {
  const rows = (await listSystemRoleOverrides(tenantId, clientId)).filter((r) => r.system_key === systemKey);
  return rows[0]?.permissions ?? null;
}

/**
 * Save one business's permissions for a SYSTEM role (create the override on first save).
 * Optimistic concurrency like custom roles: `expectedVersion` null = "there was no override
 * when I opened it". The audit event commits with the change.
 */
export async function saveSystemRoleOverride(p: {
  tenantId: string;
  clientId: string;
  systemKey: SystemRoleKeyDb;
  label: string;
  expectedVersion: number | null;
  permissions: readonly string[];
  defaultPermissions: readonly string[];
  actorUserId: string;
  actorEmail: string | null;
}): Promise<{ ok: true; version: number } | { ok: false; reason: 'stale' }> {
  try {
    return await inTransaction(async (db) => {
      const cur = await db.query<{ id: string; version: number }>(
        `SELECT id, version FROM access_roles
          WHERE tenant_id = $1 AND client_id = $2 AND system_key = $3 FOR UPDATE`,
        [p.tenantId, p.clientId, p.systemKey],
      );
      const existing = cur.rows[0] ?? null;
      if ((existing?.version ?? null) !== p.expectedVersion) return { ok: false as const, reason: 'stale' as const };
      let roleId: string;
      let version: number;
      let before: string[];
      if (existing) {
        before = (await db.query<{ permission_key: string }>(`SELECT permission_key FROM access_role_permissions WHERE role_id = $1`, [existing.id])).rows.map((r) => r.permission_key);
        const upd = await db.query<{ version: number }>(
          `UPDATE access_roles SET version = version + 1, updated_by = $2, updated_at = now() WHERE id = $1 RETURNING version`,
          [existing.id, p.actorUserId],
        );
        roleId = existing.id;
        version = upd.rows[0].version;
      } else {
        before = [...p.defaultPermissions];
        const ins = await db.query<{ id: string; version: number }>(
          `INSERT INTO access_roles (tenant_id, client_id, name, system_key, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id, version`,
          [p.tenantId, p.clientId, p.label, p.systemKey, p.actorUserId],
        );
        roleId = ins.rows[0].id;
        version = ins.rows[0].version;
      }
      await writePermissions(db, roleId, p.permissions);
      const b = new Set(before);
      const a = new Set(p.permissions);
      await insertAccessAuditEvent(
        {
          tenantId: p.tenantId,
          clientId: p.clientId,
          actorUserId: p.actorUserId,
          actorEmail: p.actorEmail,
          action: 'role.updated',
          targetType: 'role',
          targetId: `system:${p.systemKey}`,
          targetLabel: p.label,
          changes: {
            system: p.systemKey,
            added: [...a].filter((k) => !b.has(k)).sort(),
            removed: [...b].filter((k) => !a.has(k)).sort(),
          },
        },
        db,
      );
      return { ok: true as const, version };
    });
  } catch (err) {
    // Two first-saves racing: the partial unique index makes the loser stale.
    if ((err as { code?: string }).code === '23505') return { ok: false, reason: 'stale' };
    throw err;
  }
}

/** Drop one business's override: the system role goes back to its default. Audited. */
export async function resetSystemRoleOverride(p: {
  tenantId: string;
  clientId: string;
  systemKey: SystemRoleKeyDb;
  label: string;
  actorUserId: string;
  actorEmail: string | null;
}): Promise<boolean> {
  return inTransaction(async (db) => {
    const del = await db.query<{ id: string }>(
      `DELETE FROM access_roles WHERE tenant_id = $1 AND client_id = $2 AND system_key = $3 RETURNING id`,
      [p.tenantId, p.clientId, p.systemKey],
    );
    if (del.rowCount === 0) return false;
    await insertAccessAuditEvent(
      {
        tenantId: p.tenantId,
        clientId: p.clientId,
        actorUserId: p.actorUserId,
        actorEmail: p.actorEmail,
        action: 'role.updated',
        targetType: 'role',
        targetId: `system:${p.systemKey}`,
        targetLabel: p.label,
        changes: { system: p.systemKey, reset: true },
      },
      db,
    );
    return true;
  });
}

/** The most recent access changes of one business (newest first). */
export async function listAccessAuditEvents(tenantId: string, clientId: string, limit = 50): Promise<AccessAuditRow[]> {
  const result = await query<AccessAuditRow>(
    `SELECT id, action, target_type, target_id, target_label, actor_email, changes, created_at
       FROM access_audit_events
      WHERE tenant_id = $1 AND client_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenantId, clientId, Math.min(Math.max(limit, 1), 200)],
  );
  return result.rows;
}
