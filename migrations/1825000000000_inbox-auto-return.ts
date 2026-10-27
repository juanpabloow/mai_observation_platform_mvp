import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * JP-2 — ESCALATED CONVERSATIONS RETURN TO THE BOT AUTOMATICALLY.
 *
 * Per-client `inbox_settings.auto_return_minutes`: how long a conversation may sit out of the bot's
 * hands (PENDING with nobody on it, or HUMAN with no human-agent message) before the platform hands
 * it back to the bot. Default 60 minutes; 0 = never (the feature is off for that client). Mirrors
 * pipeline_settings (per-tenant+client, composite FK to clients, repo COALESCEs the default if a row
 * is missing). Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE inbox_settings (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      -- A conversation out of the bot's hands (pending unattended, or human with no agent message)
      -- for this many minutes is returned to the bot (reason auto_return). 0 = never.
      auto_return_minutes integer NOT NULL DEFAULT 60 CHECK (auto_return_minutes BETWEEN 0 AND 10080),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, client_id),
      CONSTRAINT inbox_settings_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    -- Every existing non-default client gets the default; the repo also COALESCEs 60 if a row is missing.
    INSERT INTO inbox_settings (tenant_id, client_id)
      SELECT tenant_id, id FROM clients WHERE NOT is_default
    ON CONFLICT (tenant_id, client_id) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS inbox_settings;`);
}
