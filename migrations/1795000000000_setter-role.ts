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
 * ORDER MATTERS. The constraint from the previous migration (1790) only allows
 * client_role IN ('owner','editor'), so setting a row to 'setter' WHILE it is still in
 * place is rejected (SQLSTATE 23514). The first cut ran the UPDATE first and took
 * production down on an existing editor row. So for each table the order is strictly:
 *   1. DROP the old CHECK   2. UPDATE editor → setter   3. ADD the new CHECK
 * node-pg-migrate wraps the whole migration in ONE transaction, so drop→update→add is
 * atomic — a failure leaves nothing half-applied.
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
    -- tenant_members: drop the old ('editor') CHECK, migrate the rows, add the new ('setter') CHECK.
    ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_client_role_check;
    UPDATE tenant_members SET client_role = 'setter' WHERE client_role = 'editor';
    ALTER TABLE tenant_members
      ADD CONSTRAINT tenant_members_client_role_check CHECK ${clientRoleCheck('setter')};

    -- invitations: same order.
    ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_client_role_check;
    UPDATE invitations SET client_role = 'setter' WHERE client_role = 'editor';
    ALTER TABLE invitations
      ADD CONSTRAINT invitations_client_role_check CHECK ${clientRoleCheck('setter')};
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- Reverse, same drop → update → add order (the 'setter' CHECK would reject 'editor').
    ALTER TABLE tenant_members DROP CONSTRAINT IF EXISTS tenant_members_client_role_check;
    UPDATE tenant_members SET client_role = 'editor' WHERE client_role = 'setter';
    ALTER TABLE tenant_members
      ADD CONSTRAINT tenant_members_client_role_check CHECK ${clientRoleCheck('editor')};

    ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_client_role_check;
    UPDATE invitations SET client_role = 'editor' WHERE client_role = 'setter';
    ALTER TABLE invitations
      ADD CONSTRAINT invitations_client_role_check CHECK ${clientRoleCheck('editor')};
  `);
}
