import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `executions` — a generic, workflow-agnostic record of a single n8n execution.
 * The full payload is retained in `raw_data` (JSONB); structured columns hold
 * only the fields common to every n8n execution. Per-client semantic extraction
 * is driven by `field_mappings`, never by code.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('executions', {
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
    n8n_execution_id: { type: 'text', notNull: true },
    n8n_workflow_id: { type: 'text', notNull: true },
    workflow_name: { type: 'text' },
    status: { type: 'text', notNull: true },
    mode: { type: 'text' },
    started_at: { type: 'timestamptz', notNull: true },
    stopped_at: { type: 'timestamptz' },
    duration_ms: { type: 'integer' },
    raw_data: { type: 'jsonb' },
    ingested_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Idempotency guarantee: a given client's execution is stored at most once.
  pgm.addConstraint('executions', 'executions_client_id_n8n_execution_id_key', {
    unique: ['client_id', 'n8n_execution_id'],
  });

  pgm.createIndex('executions', ['client_id', { name: 'started_at', sort: 'DESC' }]);
  pgm.createIndex('executions', ['client_id', 'status']);
  pgm.createIndex('executions', ['client_id', 'n8n_workflow_id']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table also drops its indexes and constraints.
  pgm.dropTable('executions');
}
