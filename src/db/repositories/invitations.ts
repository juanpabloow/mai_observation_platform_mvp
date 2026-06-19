import { randomBytes, createHash } from 'node:crypto';
import { pool, query } from '../client.js';

/** Roles that can be invited (never 'owner' — owner = the tenant creator). */
export type InvitationRole = 'admin' | 'member';
export type InvitationStatus = 'pending' | 'accepted' | 'revoked' | 'expired';

/** A raw invitation row (token_hash deliberately omitted from the read shapes). */
export interface InvitationRow {
  id: string;
  tenant_id: string;
  email: string;
  role: InvitationRole;
  member_client_id: string | null;
  status: InvitationStatus;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
}

/** Invitation + the display names the accept page needs (no token_hash). */
export interface InvitationWithNames {
  id: string;
  tenant_id: string;
  email: string;
  role: InvitationRole;
  member_client_id: string | null;
  status: InvitationStatus;
  expires_at: Date;
  tenant_name: string;
  client_name: string | null;
}

/** Invitation row for the RBAC-3 team list (joins client + inviter; no token). */
export interface InvitationListRow {
  id: string;
  email: string;
  role: InvitationRole;
  member_client_id: string | null;
  client_name: string | null;
  status: InvitationStatus;
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  invited_by_email: string | null;
}

/** Normalize an email for storage/comparison (case-insensitive, trimmed). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A cryptographically-random, URL-safe invite token (256 bits of entropy). The
 * RAW token goes only into the emailed accept link; the DB stores its hash.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a token for storage/lookup. SHA-256 is correct here (unlike passwords):
 * the input is high-entropy + random, so there's nothing to brute-force and no
 * need for a slow KDF — we just need a one-way, collision-resistant lookup key.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Create a pending invitation, or REPLACE the existing pending one for the same
 * (tenant, email) — re-inviting issues a fresh token/role/expiry and invalidates
 * the previous link (its hash is overwritten). Upserts via the partial unique
 * index on (tenant_id, email) WHERE status='pending'. Returns the row.
 */
export async function createOrReplacePendingInvitation(params: {
  tenantId: string;
  email: string;
  role: InvitationRole;
  memberClientId: string | null;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
}): Promise<InvitationRow> {
  const email = normalizeEmail(params.email);
  const result = await query<InvitationRow>(
    `INSERT INTO invitations
       (tenant_id, email, role, member_client_id, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, email) WHERE status = 'pending'
     DO UPDATE SET
       role = EXCLUDED.role,
       member_client_id = EXCLUDED.member_client_id,
       token_hash = EXCLUDED.token_hash,
       invited_by = EXCLUDED.invited_by,
       expires_at = EXCLUDED.expires_at,
       created_at = now(),
       accepted_at = NULL
     RETURNING id, tenant_id, email, role, member_client_id, status,
               expires_at, created_at, accepted_at`,
    [
      params.tenantId,
      email,
      params.role,
      params.memberClientId,
      params.tokenHash,
      params.invitedBy,
      params.expiresAt,
    ],
  );
  return result.rows[0];
}

/**
 * Look up an invitation by its token HASH (the caller hashes the raw token). The
 * status/expiry are returned so the accept flow can distinguish pending vs
 * already-used/revoked/expired. Joins the tenant + (optional) client display
 * names for the accept page. Null when no row matches that hash.
 */
export async function getInvitationByTokenHash(
  tokenHash: string,
): Promise<InvitationWithNames | null> {
  const result = await query<InvitationWithNames>(
    `SELECT i.id, i.tenant_id, i.email, i.role, i.member_client_id, i.status,
            i.expires_at, t.name AS tenant_name, c.name AS client_name
       FROM invitations i
       JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN clients c ON c.id = i.member_client_id
      WHERE i.token_hash = $1`,
    [tokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Whether a VALID pending (unexpired) invitation exists for an email. The signup
 * hook consults this to SKIP personal-tenant creation for an invited user (they
 * join the inviting tenant on accept instead). Case-insensitive.
 */
export async function hasValidPendingInvitationForEmail(email: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM invitations
      WHERE email = $1 AND status = 'pending' AND expires_at > now()
      LIMIT 1`,
    [normalizeEmail(email)],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Atomically ACCEPT an invitation: create the tenant membership (in the INVITING
 * tenant, with the invited role/client) and flip the invite to 'accepted', in
 * ONE transaction. The invite is re-checked under FOR UPDATE so two concurrent
 * accepts can't both succeed (single-use). Returns:
 *  - 'accepted'      — membership created, invite consumed.
 *  - 'already_member'— the user was already a member of this tenant (idempotent);
 *                      the invite is still consumed.
 *  - 'already_used'  — the invite was no longer pending/valid (lost the race).
 * The caller MUST have already verified the accepting user's email matches and
 * that the user isn't bound to a different tenant.
 */
export async function acceptInvitation(params: {
  invitationId: string;
  tenantId: string;
  userId: string;
  role: InvitationRole;
  memberClientId: string | null;
}): Promise<'accepted' | 'already_member' | 'already_used'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock + re-validate the invite is still consumable (guards double-accept).
    const inv = await client.query(
      `SELECT id FROM invitations
        WHERE id = $1 AND tenant_id = $2 AND status = 'pending' AND expires_at > now()
        FOR UPDATE`,
      [params.invitationId, params.tenantId],
    );
    if (inv.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'already_used';
    }
    // Create the membership in the INVITING tenant (idempotent for this tenant).
    const ins = await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [params.tenantId, params.userId, params.role, params.memberClientId],
    );
    await client.query(
      `UPDATE invitations SET status = 'accepted', accepted_at = now() WHERE id = $1`,
      [params.invitationId],
    );
    await client.query('COMMIT');
    return (ins.rowCount ?? 0) === 0 ? 'already_member' : 'accepted';
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** All invitations for a tenant (RBAC-3 team list). No token_hash exposed. */
export async function listInvitationsForTenant(tenantId: string): Promise<InvitationListRow[]> {
  const result = await query<InvitationListRow>(
    `SELECT i.id, i.email, i.role, i.member_client_id, c.name AS client_name,
            i.status, i.expires_at, i.created_at, i.accepted_at,
            iu.email AS invited_by_email
       FROM invitations i
       LEFT JOIN clients c ON c.id = i.member_client_id
       LEFT JOIN "user" iu ON iu.id = i.invited_by
      WHERE i.tenant_id = $1
      ORDER BY i.created_at DESC`,
    [tenantId],
  );
  return result.rows;
}

/**
 * Revoke a PENDING invitation (tenant-scoped — a foreign id can never take
 * effect). Returns true when a pending invite was revoked. Already
 * accepted/revoked invites are left untouched (returns false).
 */
export async function revokeInvitation(params: {
  tenantId: string;
  invitationId: string;
}): Promise<boolean> {
  const result = await query(
    `UPDATE invitations SET status = 'revoked'
      WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
    [params.invitationId, params.tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}
