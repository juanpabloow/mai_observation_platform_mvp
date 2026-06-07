import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `clients` — one row per tenant whose n8n instance we observe.
 * Nothing workflow-specific lives here; that meaning is configured per-client
 * in `field_mappings`.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('clients', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    name: { type: 'text', notNull: true },
    n8n_base_url: { type: 'text', notNull: true },
    n8n_api_key_encrypted: { type: 'text', notNull: true },
    is_active: { type: 'boolean', notNull: true, default: true },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('clients');
}
