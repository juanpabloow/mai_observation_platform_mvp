import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Scheduling access for client-scoped platform members.
 *
 * `tenant_members.role` remains the product-wide RBAC role.  These columns add a
 * scheduling profile without teaching the whole platform business-specific roles
 * such as "barber":
 *
 *   staff     -> one login is bound to one agendable staff resource and may read
 *                only that resource's appointments;
 *   reception -> one login is bound to one site and may operate that site's agenda.
 *
 * Invitations carry the same snapshot so accepting an invite creates the complete
 * access grant atomically.  The composite foreign keys make it impossible to bind a
 * login to a site in another client/tenant or to staff from another site.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- Composite FK targets.  The leading id is already globally unique; these
    -- constraints exist so children can prove every parent in one key.
    ALTER TABLE sites
      ADD CONSTRAINT sites_id_tenant_client_key
      UNIQUE (id, tenant_id, client_id);

    ALTER TABLE staff
      ADD CONSTRAINT staff_id_tenant_site_key
      UNIQUE (id, tenant_id, site_id);

    ALTER TABLE tenant_members
      ADD COLUMN scheduling_access text,
      ADD COLUMN scheduling_site_id uuid,
      ADD COLUMN scheduling_staff_id uuid,
      ADD CONSTRAINT tenant_members_scheduling_access_check CHECK (
        (
          role = 'member' AND (
            (scheduling_access IS NULL AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL)
            OR (scheduling_access = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL)
            OR (scheduling_access = 'reception' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NULL)
          )
        )
        OR (
          role <> 'member' AND scheduling_access IS NULL
          AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL
        )
      ),
      ADD CONSTRAINT tenant_members_scheduling_site_fkey
        FOREIGN KEY (scheduling_site_id, tenant_id, member_client_id)
        REFERENCES sites (id, tenant_id, client_id),
      ADD CONSTRAINT tenant_members_scheduling_staff_fkey
        FOREIGN KEY (scheduling_staff_id, tenant_id, scheduling_site_id)
        REFERENCES staff (id, tenant_id, site_id);

    CREATE UNIQUE INDEX tenant_members_one_login_per_staff
      ON tenant_members (tenant_id, scheduling_staff_id)
      WHERE scheduling_staff_id IS NOT NULL;

    ALTER TABLE invitations
      ADD COLUMN scheduling_access text,
      ADD COLUMN scheduling_site_id uuid,
      ADD COLUMN scheduling_staff_id uuid,
      ADD CONSTRAINT invitations_scheduling_access_check CHECK (
        (
          role = 'member' AND (
            (scheduling_access IS NULL AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL)
            OR (scheduling_access = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL)
            OR (scheduling_access = 'reception' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NULL)
          )
        )
        OR (
          role <> 'member' AND scheduling_access IS NULL
          AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL
        )
      ),
      ADD CONSTRAINT invitations_scheduling_site_fkey
        FOREIGN KEY (scheduling_site_id, tenant_id, member_client_id)
        REFERENCES sites (id, tenant_id, client_id),
      ADD CONSTRAINT invitations_scheduling_staff_fkey
        FOREIGN KEY (scheduling_staff_id, tenant_id, scheduling_site_id)
        REFERENCES staff (id, tenant_id, site_id);

    CREATE UNIQUE INDEX invitations_one_pending_per_staff
      ON invitations (tenant_id, scheduling_staff_id)
      WHERE status = 'pending' AND scheduling_staff_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS invitations_one_pending_per_staff;

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_scheduling_staff_fkey,
      DROP CONSTRAINT IF EXISTS invitations_scheduling_site_fkey,
      DROP CONSTRAINT IF EXISTS invitations_scheduling_access_check,
      DROP COLUMN IF EXISTS scheduling_staff_id,
      DROP COLUMN IF EXISTS scheduling_site_id,
      DROP COLUMN IF EXISTS scheduling_access;

    DROP INDEX IF EXISTS tenant_members_one_login_per_staff;

    ALTER TABLE tenant_members
      DROP CONSTRAINT IF EXISTS tenant_members_scheduling_staff_fkey,
      DROP CONSTRAINT IF EXISTS tenant_members_scheduling_site_fkey,
      DROP CONSTRAINT IF EXISTS tenant_members_scheduling_access_check,
      DROP COLUMN IF EXISTS scheduling_staff_id,
      DROP COLUMN IF EXISTS scheduling_site_id,
      DROP COLUMN IF EXISTS scheduling_access;

    ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_id_tenant_site_key;
    ALTER TABLE sites DROP CONSTRAINT IF EXISTS sites_id_tenant_client_key;
  `);
}
