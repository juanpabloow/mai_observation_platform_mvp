import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `field_mappings` — the generic mechanism that gives raw executions meaning,
 * per client + workflow, entirely through user-defined config rows.
 *
 *  - kind 'column'       : surface a value from raw_data as a labelled table column.
 *  - kind 'conversation' : map a value to a known conversation `role`
 *                          (conversation_id, user_message, ai_response, ...).
 *
 * `json_path` points into the execution's raw_data. No workflow specifics are
 * ever hardcoded in schema or code.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('field_mappings', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    client_id: {
      type: 'uuid',
      notNull: true,
      references: 'clients',
      onDelete: 'CASCADE',
    },
    n8n_workflow_id: { type: 'text', notNull: true },
    mapping_kind: {
      type: 'text',
      notNull: true,
      check: "mapping_kind IN ('column', 'conversation')",
    },
    column_label: { type: 'text' }, // for kind 'column': the table header label
    role: { type: 'text' }, // for kind 'conversation': conversation_id | user_message | ai_response | contact_name | timestamp
    json_path: { type: 'text', notNull: true }, // path into the execution's raw_data
    data_type: { type: 'text' }, // e.g. 'string', 'number', 'boolean'
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('field_mappings', ['client_id', 'n8n_workflow_id']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('field_mappings');
}
