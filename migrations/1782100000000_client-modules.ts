import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MOD-1 (Phase 1 of the modular system): `client_modules` — which modules a
 * CLIENT (a business within a tenant) has enabled.
 *
 * Ownership: tenant → client → modules. Module data (contacts, appointments,
 * sites) is owned at the client level; workflows will later CONSUME modules
 * (workflow_modules, a later phase — deliberately NOT created here) but never
 * own module data. The ABSENCE of a row means the module is DISABLED; a row with
 * enabled=false preserves prior settings while switched off.
 *
 * Known module keys in this phase: 'crm' and 'scheduling' (mirrors the pure
 * registry in src/modules/registry.ts — keep the CHECK below in sync when a new
 * module is added).
 *
 * Constraints:
 * - Composite FK (client_id, tenant_id) → clients (id, tenant_id): the client
 *   must exist IN THIS TENANT (same-tenant guarantee the RBAC model relies on;
 *   the composite unique on clients enables the reference). ON DELETE CASCADE —
 *   module rows are meaningless without their client.
 * - UNIQUE (tenant_id, client_id, module_key): one row per module per client
 *   (the upsert target).
 * - CHECK module_key IN ('crm','scheduling') and CHECK settings is a JSON
 *   OBJECT (jsonb_typeof = 'object') — never an array/scalar.
 *
 * CONSERVATIVE backfill (evidence-based, never global):
 * - 'crm' only for clients that already have ≥1 contact.
 * - 'scheduling' only for clients that already have ≥1 site.
 * Scheduling does NOT imply the CRM surface: each module is enabled only on its
 * own evidence. ON CONFLICT DO NOTHING keeps the migration re-runnable on a base
 * that somehow already has rows, and both subqueries are empty on a fresh DB, so
 * it works on new and populated databases alike.
 *
 * down drops ONLY client_modules.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE client_modules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      client_id uuid NOT NULL,
      module_key text NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT client_modules_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT client_modules_unique UNIQUE (tenant_id, client_id, module_key),
      CONSTRAINT client_modules_key_check CHECK (module_key IN ('crm', 'scheduling')),
      CONSTRAINT client_modules_settings_object CHECK (jsonb_typeof(settings) = 'object')
    );

    -- "Which modules are enabled across this tenant's clients" — the tenant-wide
    -- listing/guard query (partial on enabled: disabled rows are rarely scanned).
    CREATE INDEX client_modules_tenant_enabled_idx
      ON client_modules (tenant_id, client_id, module_key)
      WHERE enabled;

    -- Backfill 'crm' for clients with existing CRM evidence (≥1 contact).
    INSERT INTO client_modules (tenant_id, client_id, module_key)
    SELECT DISTINCT c.tenant_id, c.id, 'crm'
      FROM clients c
     WHERE EXISTS (SELECT 1 FROM contacts ct WHERE ct.client_id = c.id AND ct.tenant_id = c.tenant_id)
    ON CONFLICT (tenant_id, client_id, module_key) DO NOTHING;

    -- Backfill 'scheduling' for clients with existing scheduling evidence (≥1 site).
    INSERT INTO client_modules (tenant_id, client_id, module_key)
    SELECT DISTINCT s.tenant_id, s.client_id, 'scheduling'
      FROM sites s
    ON CONFLICT (tenant_id, client_id, module_key) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS client_modules;`);
}
