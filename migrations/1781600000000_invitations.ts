import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * RBAC-2: tenant invitations. A pending invite is credential-like — a valid
 * token grants its holder access to the inviting tenant with a specific role
 * (and, for a member, a specific client). So we store only a HASH of the token
 * (a DB leak never exposes a usable token), the token is single-use + expiring,
 * and the same role↔client + same-tenant guarantees as tenant_members apply.
 *
 * - role ∈ (admin|member) — you cannot invite an 'owner' (owner = tenant creator).
 * - member_client_id: REQUIRED for 'member', NULL for 'admin' (role↔client CHECK),
 *   and must be a client OF THIS tenant — enforced in the DB by the composite FK
 *   (member_client_id, tenant_id) → clients(id, tenant_id), exactly like RBAC-1
 *   (reusing the clients_id_tenant_id_key unique target added then).
 * - token_hash UNIQUE: lookup on accept is by hash; the raw token lives only in
 *   the emailed link.
 * - status ∈ (pending|accepted|revoked|expired). At most ONE pending invite per
 *   (tenant, email): a partial unique index. Re-inviting upserts that row.
 *   Expiry is enforced by comparing expires_at at accept time; the 'expired'
 *   status value exists for an optional future sweep.
 * - invited_by → "user"(id) ON DELETE CASCADE; tenant_id → tenants ON DELETE
 *   CASCADE (an invite is meaningless without its tenant/inviter).
 *
 * Reversible: down drops the table (and its indexes/constraints) entirely.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE invitations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      email text NOT NULL,
      role text NOT NULL CHECK (role IN ('admin', 'member')),
      member_client_id uuid,
      token_hash text NOT NULL,
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
      invited_by text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      accepted_at timestamptz,

      -- same role↔client invariant as tenant_members
      CONSTRAINT invitations_role_client_check CHECK (
        (role = 'member' AND member_client_id IS NOT NULL)
        OR (role <> 'member' AND member_client_id IS NULL)
      ),
      -- the assigned client must belong to THIS invite's tenant (DB-enforced)
      CONSTRAINT invitations_member_client_id_fkey
        FOREIGN KEY (member_client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );

    CREATE INDEX invitations_tenant_id_idx ON invitations (tenant_id);
    CREATE INDEX invitations_email_idx ON invitations (email);
    CREATE UNIQUE INDEX invitations_token_hash_key ON invitations (token_hash);
    -- at most one PENDING invite per (tenant, email); re-invites upsert this row
    CREATE UNIQUE INDEX invitations_one_pending_per_tenant_email
      ON invitations (tenant_id, email) WHERE status = 'pending';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS invitations;`);
}
