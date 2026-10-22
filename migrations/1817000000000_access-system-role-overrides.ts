import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SYSTEM-ROLE OVERRIDES per business (decision 2026-10-22, on top of 1816 access-roles).
 *
 * The agency may adjust the permissions of a SYSTEM role (Dueño = owner, Recepción = setter,
 * Profesional = staff) for ONE business. The adjustment is a row in access_roles with
 * `system_key` set; its permissions live in access_role_permissions like a custom role's.
 * Every member of that business with that client_role resolves to it on their next request
 * (web/lib/access.ts). No row = the code default (web/lib/permissions/catalog.ts). Deleting
 * the row restores the default.
 *
 *  - system_key NULL = a custom role (every row that exists today: nothing is backfilled).
 *  - At most ONE override per (tenant, business, system role): partial unique index.
 *  - Override rows are never assigned through tenant_members/invitations.access_role_id —
 *    the app resolves them only by system_key and every custom-role read filters
 *    `system_key IS NULL`.
 *
 * Reversible: down() deletes the override rows (the businesses go back to the defaults —
 * the same permissions every system role had before this migration) and drops the column.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE access_roles
      ADD COLUMN system_key text CHECK (system_key IN ('owner', 'setter', 'staff'));
    CREATE UNIQUE INDEX access_roles_one_override_per_system_role
      ON access_roles (tenant_id, client_id, system_key) WHERE system_key IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DELETE FROM access_roles WHERE system_key IS NOT NULL;
    DROP INDEX IF EXISTS access_roles_one_override_per_system_role;
    ALTER TABLE access_roles DROP COLUMN IF EXISTS system_key;
  `);
}
