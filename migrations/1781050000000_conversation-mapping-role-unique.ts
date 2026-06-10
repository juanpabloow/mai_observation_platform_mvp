import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * At most ONE conversation mapping per (tenant, workflow, role). A PARTIAL unique
 * index (scoped to mapping_kind='conversation') enforces this at the DB level and
 * enables an ON CONFLICT upsert (re-picking a role overwrites it). Column
 * mappings (role NULL, mapping_kind='column') are unaffected.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE UNIQUE INDEX field_mappings_conversation_role_uniq
      ON field_mappings (tenant_id, n8n_workflow_id, role)
      WHERE mapping_kind = 'conversation';
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP INDEX field_mappings_conversation_role_uniq;`);
}
