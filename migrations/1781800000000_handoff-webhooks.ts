import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * H-3: handoff_webhooks — the platform→workflow send target. One webhook per
 * workflow (UNIQUE tenant_id + n8n_workflow_id), keyed by n8n_workflow_id text
 * (like conversations) and NOT FK'd to the synced workflows rows — those get
 * re-synced/replaced, and a webhook must outlive that.
 *
 * - url: an HTTPS endpoint the platform POSTs signed messages to (http:// allowed
 *   ONLY for localhost, enforced at the app layer — never here, so dev works).
 * - secret_encrypted: a platform-generated symmetric secret ("whs_"+32B base64url),
 *   ENCRYPTED at rest with the same AES-256-GCM utility as n8n API keys — NOT hashed,
 *   because we must decrypt it to HMAC-sign each outbound body (and the customer
 *   holds the same secret to verify). Revealed only to owner/admin on explicit click.
 * - enabled: a kill switch; last_delivery_at/status: a cheap health signal.
 *
 * Fully reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE handoff_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      n8n_workflow_id text NOT NULL,
      url text NOT NULL,
      secret_encrypted text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      last_delivery_at timestamptz,
      last_delivery_status text CHECK (last_delivery_status IN ('sent', 'rejected', 'failed')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (tenant_id, n8n_workflow_id)
    );
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS handoff_webhooks;`);
}
