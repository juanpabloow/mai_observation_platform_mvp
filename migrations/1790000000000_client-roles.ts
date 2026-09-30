import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * CLIENT-LEVEL ROLES — Owner / Editor / Staff for the people who work AT a client
 * (e.g. the barbershop), distinct from the agency's tenant-level owner/admin/member.
 *
 * This RETIRES `scheduling_access` (staff | reception) and replaces it with a single
 * authoritative `client_role` on the same rows, so there is ONE source of truth for
 * what a client-scoped login may do:
 *
 *   owner  -> full control of THIS client: inbox, contacts, agenda (whole client),
 *             scheduling settings, custom fields, and managing this client's team
 *             (Editors/Staff). Never another client, never tenant-level surfaces.
 *   editor -> the operational role: inbox, contacts, agenda (whole client) and
 *             booking. No settings, no custom fields, no team. (This is where the old
 *             `reception` — scheduling-only, single-site — collapses to, and where a
 *             legacy "standard client member" lands.)
 *   staff  -> their own agenda: they SEE their whole site and may create/modify only
 *             their OWN column. Bound to one site + one staff resource; never sees
 *             contacts, inbox, analytics or settings.
 *
 * `client_role` is meaningful ONLY for role = 'member' (owner/admin are agency-level
 * and carry no client_role). The site/staff binding survives, but is now non-null
 * ONLY for `staff` (owner/editor see the whole client). The composite FKs from the
 * previous migration still prove the site belongs to the member's client and the
 * staff to that site; the one-login-per-staff unique index is untouched.
 *
 * BACKFILL (reversible): staff -> staff; reception -> editor (its single-site binding
 * is dropped — Editor is whole-client); NULL (standard member) -> editor. Client
 * Owners are NEVER created automatically — the agency assigns them explicitly.
 */

const CLIENT_ROLE_CHECK = `(
  (
    role = 'member' AND (
      (client_role IN ('owner','editor') AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL)
      OR (client_role = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL)
    )
  )
  OR (
    role <> 'member' AND client_role IS NULL
    AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL
  )
)`;

// The original access CHECK this migration replaces (re-created on down()).
const OLD_SCHEDULING_ACCESS_CHECK = `(
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
)`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE tenant_members ADD COLUMN client_role text;
    ALTER TABLE invitations ADD COLUMN client_role text;

    -- Backfill from the retiring scheduling_access. reception + standard both become
    -- editor; only staff keeps its site/staff binding (owner/editor see whole client).
    UPDATE tenant_members
       SET client_role = CASE scheduling_access WHEN 'staff' THEN 'staff' ELSE 'editor' END,
           scheduling_site_id = CASE scheduling_access WHEN 'staff' THEN scheduling_site_id ELSE NULL END,
           scheduling_staff_id = CASE scheduling_access WHEN 'staff' THEN scheduling_staff_id ELSE NULL END
     WHERE role = 'member';

    UPDATE invitations
       SET client_role = CASE scheduling_access WHEN 'staff' THEN 'staff' ELSE 'editor' END,
           scheduling_site_id = CASE scheduling_access WHEN 'staff' THEN scheduling_site_id ELSE NULL END,
           scheduling_staff_id = CASE scheduling_access WHEN 'staff' THEN scheduling_staff_id ELSE NULL END
     WHERE role = 'member';

    -- Swap the constraint + drop the retired column. The composite FKs on
    -- (scheduling_site_id, tenant_id, member_client_id) and (scheduling_staff_id,
    -- tenant_id, scheduling_site_id), and the one-login-per-staff unique indexes, all
    -- reference columns that survive, so they stay in place untouched.
    ALTER TABLE tenant_members
      DROP CONSTRAINT IF EXISTS tenant_members_scheduling_access_check,
      DROP COLUMN scheduling_access,
      ADD CONSTRAINT tenant_members_client_role_check CHECK ${CLIENT_ROLE_CHECK};

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_scheduling_access_check,
      DROP COLUMN scheduling_access,
      ADD CONSTRAINT invitations_client_role_check CHECK ${CLIENT_ROLE_CHECK};
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE tenant_members ADD COLUMN scheduling_access text;
    ALTER TABLE invitations ADD COLUMN scheduling_access text;

    -- Reverse: staff -> 'staff' (binding intact); owner/editor -> NULL (a plain client
    -- member). Client Owner has no pre-image in the old model, so it degrades to a
    -- standard member on down — documented and acceptable for a rollback.
    UPDATE tenant_members
       SET scheduling_access = CASE client_role WHEN 'staff' THEN 'staff' ELSE NULL END
     WHERE role = 'member';
    UPDATE invitations
       SET scheduling_access = CASE client_role WHEN 'staff' THEN 'staff' ELSE NULL END
     WHERE role = 'member';

    ALTER TABLE tenant_members
      DROP CONSTRAINT IF EXISTS tenant_members_client_role_check,
      DROP COLUMN client_role,
      ADD CONSTRAINT tenant_members_scheduling_access_check CHECK ${OLD_SCHEDULING_ACCESS_CHECK};

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_client_role_check,
      DROP COLUMN client_role,
      ADD CONSTRAINT invitations_scheduling_access_check CHECK ${OLD_SCHEDULING_ACCESS_CHECK};
  `);
}
