import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * RBAC-1: roles + per-member client scoping on tenant_members (the authorization
 * core — controls which clients' data a user may see WITHIN their tenant).
 *
 * - role gains a CHECK restricting it to ('owner','admin','member'). It was free
 *   text; every existing row is 'owner' (they stay owners). owner/admin = full
 *   data access; a 'member' is scoped to exactly ONE client.
 * - member_client_id (nullable FK → clients) names the single client a 'member'
 *   may see. It is NULL for owner/admin.
 * - A role↔client CHECK enforces the invariant in the DB (also enforced in code):
 *       role = 'member'  ⇒ member_client_id IS NOT NULL
 *       role <> 'member' ⇒ member_client_id IS NULL
 * - The assigned client must belong to the SAME tenant as the membership. A
 *   single-table CHECK can't reach across to clients, so we enforce it with a
 *   COMPOSITE FK (member_client_id, tenant_id) → clients (id, tenant_id). That
 *   needs a UNIQUE(id, tenant_id) on clients as the FK target (id is already the
 *   PK, so the extra unique index only enables the composite reference). A NULL
 *   member_client_id skips the FK (MATCH SIMPLE), so owner/admin rows are exempt
 *   and it composes cleanly with the role↔client CHECK above.
 * - Every FK here is NO ACTION (the default). Deleting a client that a member is
 *   assigned to is BLOCKED (a member still references it at statement end), but
 *   tenant deletion still cascades cleanly: a tenant's members + clients are all
 *   removed together, so nothing dangles when the FK is checked. (Same reasoning
 *   the CL-1a workflows.client_id FK relies on.)
 *
 * Fully reversible: down drops the two CHECKs, the composite FK, the column, and
 * the clients unique index — restoring role to free text and the prior schema.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- 1. restrict role to the three known values (was unconstrained text; every
    --    existing row is 'owner', so this is satisfied immediately).
    ALTER TABLE tenant_members
      ADD CONSTRAINT tenant_members_role_check
      CHECK (role IN ('owner', 'admin', 'member'));

    -- 2. the ONE client a 'member' is scoped to (NULL for owner/admin).
    ALTER TABLE tenant_members
      ADD COLUMN member_client_id uuid;

    -- 3. FK target for the composite (same-tenant) reference. clients.id is the
    --    PK (already unique); this pair only lets us reference (id, tenant_id).
    ALTER TABLE clients
      ADD CONSTRAINT clients_id_tenant_id_key UNIQUE (id, tenant_id);

    -- 4. composite FK: the assigned client must EXIST and be in THIS membership's
    --    tenant. NULL member_client_id (owner/admin) skips this (MATCH SIMPLE).
    --    NO ACTION on delete: blocks deleting an assigned client; tenant cascade
    --    is unaffected (checked at statement end, by which point both are gone).
    ALTER TABLE tenant_members
      ADD CONSTRAINT tenant_members_member_client_id_fkey
      FOREIGN KEY (member_client_id, tenant_id)
      REFERENCES clients (id, tenant_id);

    -- 5. role↔client invariant: member ⇒ has a client; owner/admin ⇒ no client.
    ALTER TABLE tenant_members
      ADD CONSTRAINT tenant_members_role_client_check
      CHECK (
        (role = 'member' AND member_client_id IS NOT NULL)
        OR (role <> 'member' AND member_client_id IS NULL)
      );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE tenant_members
      DROP CONSTRAINT IF EXISTS tenant_members_role_client_check,
      DROP CONSTRAINT IF EXISTS tenant_members_member_client_id_fkey,
      DROP CONSTRAINT IF EXISTS tenant_members_role_check,
      DROP COLUMN IF EXISTS member_client_id;

    ALTER TABLE clients
      DROP CONSTRAINT IF EXISTS clients_id_tenant_id_key;
  `);
}
