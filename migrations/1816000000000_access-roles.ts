import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * ACCESS ROLES v1 — custom, per-business roles made of permissions, plus an access audit
 * trail (docs/proposals/roles-permisos-v1.md).
 *
 * WHAT A ROLE IS. A set of keys from the code catalog (web/lib/permissions/catalog.ts).
 * The three SYSTEM roles (Dueño = owner, Recepción = setter, Profesional = staff) stay
 * exactly as they are: they keep living in `tenant_members.client_role`, their permission
 * sets are defined in code, and NO existing row is touched by this migration. A CUSTOM role
 * is a row here, owned by ONE business (client) of ONE tenant, and a member holding it has
 * `client_role = 'custom'` + `access_role_id`.
 *
 * SYSTEM-ROLE OVERRIDES. The agency may adjust the permissions of a SYSTEM role for ONE
 * business (decision 2026-10-22): a row in access_roles with `system_key` set
 * ('owner' | 'setter' | 'staff') holds that business's set, and every member of that business
 * with that client_role resolves to it. No row = the code default. Override rows are never
 * assigned through access_role_id (the app only resolves them by system_key) and at most one
 * exists per (tenant, business, system role). Deleting it restores the default.
 *
 * THE SCOPE stays on the membership: a custom role always works on the whole business
 * (no site/staff binding — that is the Profesional system role), proven by the CHECK below.
 *
 *  - access_roles: name/description chosen by the business. UNIQUE name per business
 *    (case/space-insensitive). Composite FK (client_id, tenant_id) → clients so a role can
 *    never belong to a client of another tenant. `version` is bumped on every edit
 *    (optimistic concurrency for the editor; there is no authorization cache to bust —
 *    every request re-reads the membership and its role).
 *  - access_role_permissions: (role_id, permission_key). The key is free text shaped like
 *    `area.action`; the catalog — not the DB — decides which keys mean anything, and an
 *    unknown key is ignored (deny by default).
 *  - tenant_members.access_role_id / invitations.access_role_id: composite FK
 *    (access_role_id, tenant_id, member_client_id) → access_roles(id, tenant_id, client_id):
 *    the role must belong to the SAME tenant AND the SAME business as the membership.
 *    NO ACTION (checked at statement end) — deleting a role that someone holds or that a
 *    pending invitation offers is refused, while deleting a whole tenant still cascades.
 *  - client_role admits 'custom'; the CHECK ties it to access_role_id both ways.
 *  - access_audit_events: who changed which role / assignment / invitation, what changed
 *    (permission keys added/removed, role before/after), in which tenant/business, when.
 *    No message content, no tokens, no secrets. client_id carries no FK on purpose so the
 *    trail outlives a deleted business; the tenant FK cascades.
 *
 * ROLLBACK: down() refuses (raises) while any membership or pending invitation still uses
 * a custom role — degrading them to a system role would silently change what they can do.
 * Reassign them first.
 */

const CHECK_WITH_CUSTOM = `(
  (
    role = 'member' AND (
      (client_role IN ('owner','setter') AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL AND access_role_id IS NULL)
      OR (client_role = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL AND access_role_id IS NULL)
      OR (client_role = 'custom' AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL AND access_role_id IS NOT NULL)
    )
  )
  OR (
    role <> 'member' AND client_role IS NULL
    AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL AND access_role_id IS NULL
  )
)`;

// The 1795 constraint this migration replaces (re-created on down()).
const CHECK_SETTER = `(
  (
    role = 'member' AND (
      (client_role IN ('owner','setter') AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL)
      OR (client_role = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL)
    )
  )
  OR (
    role <> 'member' AND client_role IS NULL
    AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL
  )
)`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE access_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
      description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 280),
      version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
      -- non-null = this business's override of a SYSTEM role (see header); null = custom role.
      system_key text CHECK (system_key IN ('owner', 'setter', 'staff')),
      created_by text REFERENCES "user" (id) ON DELETE SET NULL,
      updated_by text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT access_roles_client_fkey
        FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      -- FK target for memberships/invitations: proves role, tenant and business in one key.
      CONSTRAINT access_roles_id_tenant_client_key UNIQUE (id, tenant_id, client_id)
    );
    CREATE UNIQUE INDEX access_roles_client_name_key
      ON access_roles (tenant_id, client_id, lower(btrim(name)));
    CREATE UNIQUE INDEX access_roles_one_override_per_system_role
      ON access_roles (tenant_id, client_id, system_key) WHERE system_key IS NOT NULL;

    CREATE TABLE access_role_permissions (
      role_id uuid NOT NULL REFERENCES access_roles (id) ON DELETE CASCADE,
      permission_key text NOT NULL CHECK (permission_key ~ '^[a-z_]+(\\.[a-z_]+)+$'),
      PRIMARY KEY (role_id, permission_key)
    );

    ALTER TABLE tenant_members ADD COLUMN access_role_id uuid;
    ALTER TABLE invitations ADD COLUMN access_role_id uuid;

    ALTER TABLE tenant_members
      ADD CONSTRAINT tenant_members_access_role_fkey
        FOREIGN KEY (access_role_id, tenant_id, member_client_id)
        REFERENCES access_roles (id, tenant_id, client_id);
    ALTER TABLE invitations
      ADD CONSTRAINT invitations_access_role_fkey
        FOREIGN KEY (access_role_id, tenant_id, member_client_id)
        REFERENCES access_roles (id, tenant_id, client_id);

    CREATE INDEX tenant_members_access_role_idx ON tenant_members (access_role_id) WHERE access_role_id IS NOT NULL;
    CREATE INDEX invitations_access_role_idx ON invitations (access_role_id) WHERE access_role_id IS NOT NULL;

    -- Swap the CHECK (no row changes: every existing row has access_role_id NULL and a
    -- system client_role, which the new CHECK admits exactly as the old one did).
    ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_client_role_check;
    ALTER TABLE tenant_members ADD CONSTRAINT tenant_members_client_role_check CHECK ${CHECK_WITH_CUSTOM};
    ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_client_role_check;
    ALTER TABLE invitations ADD CONSTRAINT invitations_client_role_check CHECK ${CHECK_WITH_CUSTOM};

    CREATE TABLE access_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid,
      actor_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      actor_email text,
      action text NOT NULL CHECK (action IN (
        'role.created', 'role.updated', 'role.deleted',
        'member.role_changed', 'member.client_changed', 'member.tenant_role_changed', 'member.removed',
        'invitation.created', 'invitation.revoked'
      )),
      target_type text NOT NULL CHECK (target_type IN ('role', 'member', 'invitation')),
      target_id text NOT NULL,
      target_label text,
      changes jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX access_audit_events_client_idx
      ON access_audit_events (tenant_id, client_id, created_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM tenant_members WHERE access_role_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM invitations WHERE access_role_id IS NOT NULL AND status = 'pending') THEN
        RAISE EXCEPTION 'access-roles down(): custom roles are still assigned — reassign those logins/invitations to a system role first';
      END IF;
    END $$;

    -- Non-pending invitations may still reference a role: they are history, clear it.
    UPDATE invitations SET client_role = 'setter', access_role_id = NULL
     WHERE access_role_id IS NOT NULL AND status <> 'pending';

    DROP TABLE IF EXISTS access_audit_events;

    ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_client_role_check;
    ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_client_role_check;
    ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_access_role_fkey;
    ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_access_role_fkey;
    DROP INDEX IF EXISTS invitations_access_role_idx;
    DROP INDEX IF EXISTS tenant_members_access_role_idx;
    ALTER TABLE invitations DROP COLUMN IF EXISTS access_role_id;
    ALTER TABLE tenant_members DROP COLUMN IF EXISTS access_role_id;

    ALTER TABLE tenant_members ADD CONSTRAINT tenant_members_client_role_check CHECK ${CHECK_SETTER};
    ALTER TABLE invitations ADD CONSTRAINT invitations_client_role_check CHECK ${CHECK_SETTER};

    DROP TABLE IF EXISTS access_role_permissions;
    DROP TABLE IF EXISTS access_roles;
  `);
}
