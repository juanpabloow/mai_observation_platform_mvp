import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SETTER replaces EDITOR (client-level role).
 *
 * The business's operating document (Gallery) calls the person who works the chats and
 * closes bookings the "Setter". Functionally Setter = the old Editor MINUS analytics,
 * executions and workflow internals — so rather than keep two near-identical client
 * roles (which confuse whoever sends invitations), Editor is renamed to Setter and the
 * code narrows what it can reach (see web/lib/access.ts: canSeeWorkflowInsights).
 *
 * This migration ONLY renames the stored value + its CHECK constraint on tenant_members
 * and invitations. It does NOT touch owner/staff. It is reversible.
 *
 * DEPLOY NOTE: before running this on production, list who currently holds `editor`
 * (SELECT ... WHERE client_role='editor') and promote anyone who must KEEP analytics to
 * `owner` first — this rename otherwise moves every editor to the narrower setter role.
 */

const clientRoleCheck = (op: string) => `(
  (
    role = 'member' AND (
      (client_role IN ('owner','${op}') AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL)
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
    UPDATE tenant_members SET client_role = 'setter' WHERE client_role = 'editor';
    UPDATE invitations    SET client_role = 'setter' WHERE client_role = 'editor';

    ALTER TABLE tenant_members
      DROP CONSTRAINT IF EXISTS tenant_members_client_role_check,
      ADD CONSTRAINT tenant_members_client_role_check CHECK ${clientRoleCheck('setter')};

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_client_role_check,
      ADD CONSTRAINT invitations_client_role_check CHECK ${clientRoleCheck('setter')};
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    UPDATE tenant_members SET client_role = 'editor' WHERE client_role = 'setter';
    UPDATE invitations    SET client_role = 'editor' WHERE client_role = 'setter';

    ALTER TABLE tenant_members
      DROP CONSTRAINT IF EXISTS tenant_members_client_role_check,
      ADD CONSTRAINT tenant_members_client_role_check CHECK ${clientRoleCheck('editor')};

    ALTER TABLE invitations
      DROP CONSTRAINT IF EXISTS invitations_client_role_check,
      ADD CONSTRAINT invitations_client_role_check CHECK ${clientRoleCheck('editor')};
  `);
}
