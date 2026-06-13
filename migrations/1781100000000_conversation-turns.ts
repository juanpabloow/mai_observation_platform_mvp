import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `conversation_turns` — DERIVED data: one row per execution that represents a
 * real chat turn (a user message, plus its AI reply if captured), reconstructed
 * by applying a workflow's conversation mappings to the execution. Non-message
 * executions (e.g. status callbacks) produce no row. The source raw_data is
 * never modified; this table is fully rebuildable from executions + mappings.
 *
 * UNIQUE(execution_id) makes re-derivation idempotent (upsert), mirroring the
 * ingestion idempotency guarantee. Both FKs cascade so turns disappear with
 * their execution or tenant.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('conversation_turns', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    tenant_id: {
      type: 'uuid',
      notNull: true,
      references: 'tenants',
      onDelete: 'CASCADE',
    },
    n8n_workflow_id: { type: 'text', notNull: true },
    execution_id: {
      type: 'uuid',
      notNull: true,
      references: 'executions',
      onDelete: 'CASCADE',
    },
    conversation_id: { type: 'text', notNull: true },
    contact_name: { type: 'text' },
    user_message: { type: 'text' },
    ai_response: { type: 'text' },
    turn_timestamp: { type: 'timestamptz', notNull: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // One turn per execution — re-deriving upserts rather than duplicating.
  pgm.addConstraint('conversation_turns', 'conversation_turns_execution_id_key', {
    unique: ['execution_id'],
  });

  // Fast thread fetch (all turns of one conversation, in time order).
  pgm.createIndex('conversation_turns', [
    'tenant_id',
    'n8n_workflow_id',
    'conversation_id',
    'turn_timestamp',
  ]);
  // Fast conversation list (group by conversation, order by activity).
  pgm.createIndex('conversation_turns', ['tenant_id', 'n8n_workflow_id', 'turn_timestamp']);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Dropping the table also drops its indexes and constraints.
  pgm.dropTable('conversation_turns');
}
