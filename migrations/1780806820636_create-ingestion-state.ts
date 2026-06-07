import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `ingestion_state` — per-client polling cursor and health.
 * One row per client (client_id is the PK). Populated/updated by the poller in
 * a later step; created here so the schema is complete.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('ingestion_state', {
    client_id: {
      type: 'uuid',
      primaryKey: true,
      references: 'clients',
      onDelete: 'CASCADE',
    },
    last_seen_execution_id: { type: 'text' },
    last_polled_at: { type: 'timestamptz' },
    last_successful_poll_at: { type: 'timestamptz' },
    consecutive_failures: { type: 'integer', notNull: true, default: 0 },
    last_error: { type: 'text' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('ingestion_state');
}
