import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Make field_mappings suitable for workflow-scoped 'column' mappings:
 *  - n8n_connection_id becomes NULLABLE — a column belongs to a workflow within
 *    a tenant (tenant_id + n8n_workflow_id), not to a specific connection.
 *  - add node_name — a column's json_path is relative to ONE node's unwrapped
 *    output, so we record which node it came from.
 *  - index (tenant_id, n8n_workflow_id) — how column mappings are looked up.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE field_mappings ALTER COLUMN n8n_connection_id DROP NOT NULL;
    ALTER TABLE field_mappings ADD COLUMN node_name text;
    CREATE INDEX field_mappings_tenant_id_n8n_workflow_id_index
      ON field_mappings (tenant_id, n8n_workflow_id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverting requires no NULL-connection rows (the old shape required one), so
  // drop column mappings that have no connection before restoring NOT NULL.
  pgm.sql(`
    DROP INDEX field_mappings_tenant_id_n8n_workflow_id_index;
    ALTER TABLE field_mappings DROP COLUMN node_name;
    DELETE FROM field_mappings WHERE n8n_connection_id IS NULL;
    ALTER TABLE field_mappings ALTER COLUMN n8n_connection_id SET NOT NULL;
  `);
}
