import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `tenant_members` — the seam linking Better Auth users to tenants. A separate
 * membership table (rather than a tenant_id column on the Better Auth `user`
 * table) so a user can belong to multiple tenants later and invitations/RBAC fit
 * cleanly. For now every membership is role='owner' (the tenant creator); 'member'
 * is reserved for invitations. No role ENFORCEMENT yet.
 *
 * user_id is TEXT because Better Auth's `user`.id is text. Both FKs cascade so a
 * membership disappears with its tenant or its user. UNIQUE(tenant_id, user_id)
 * prevents duplicate memberships; the (user_id) index powers the session →
 * tenant lookup in getCurrentTenantId().
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE tenant_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'owner',
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tenant_members_tenant_id_user_id_key UNIQUE (tenant_id, user_id)
    );
    CREATE INDEX tenant_members_user_id_idx ON tenant_members (user_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS tenant_members;`);
}
