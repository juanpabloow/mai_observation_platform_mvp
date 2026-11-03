import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * COSTOS DE IA — what OpenAI actually BILLED, next to the estimate derived from n8n.
 *
 * `openai_connections`: one per tenant (the agency). The OpenAI organization Admin key,
 * ENCRYPTED with ENCRYPTION_KEY like the n8n keys (src/crypto.ts); only `key_hint` (last 4
 * characters) is ever shown. Plus the last sync state.
 *
 * `openai_daily_costs`: GET /v1/organization/costs, one row per UTC day × project × line item,
 * in US$. This is the endpoint OpenAI reconciles with the invoice.
 *
 * `openai_daily_usage`: GET /v1/organization/usage/completions, one row per UTC day × project ×
 * model: requests and input / cached input / output tokens (the provider's own counts).
 *
 * Both are caches of OpenAI's data: the sync replaces the synced window. '' = not grouped /
 * unknown (OpenAI returns null). Deleting the connection keeps nothing secret behind (the
 * figures stay; they are not credentials). Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE openai_connections (
      tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
      admin_key_encrypted text NOT NULL,
      key_hint text NOT NULL CHECK (char_length(key_hint) BETWEEN 1 AND 8),
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_synced_at timestamptz,
      -- Every attempt, ok or not: the worker waits between attempts, so a bad key is not
      -- retried against OpenAI on every cycle.
      last_attempt_at timestamptz,
      last_sync_error text CHECK (last_sync_error IS NULL OR char_length(last_sync_error) <= 300)
    );

    CREATE TABLE openai_daily_costs (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      day date NOT NULL,
      project_id text NOT NULL DEFAULT '',
      line_item text NOT NULL DEFAULT '',
      amount_usd numeric(14, 6) NOT NULL,
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, day, project_id, line_item)
    );

    CREATE TABLE openai_daily_usage (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      day date NOT NULL,
      project_id text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '',
      requests bigint NOT NULL CHECK (requests >= 0),
      input_tokens bigint NOT NULL CHECK (input_tokens >= 0),
      cached_input_tokens bigint NOT NULL CHECK (cached_input_tokens >= 0),
      output_tokens bigint NOT NULL CHECK (output_tokens >= 0),
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, day, project_id, model)
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE openai_daily_usage;
    DROP TABLE openai_daily_costs;
    DROP TABLE openai_connections;
  `);
}
