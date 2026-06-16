import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Client model (CL-1a): every workflow belongs to exactly ONE client, with a
 * per-tenant DEFAULT client as the home for ungrouped workflows.
 *
 * - clients gains is_default (one per tenant, enforced by a partial unique index)
 *   and logo_url (column only; upload is CL-3).
 * - Backfill: every existing tenant gets a default client (named after the
 *   tenant); every workflow with a null client_id is assigned to its tenant's
 *   default client. THEN workflows.client_id becomes NOT NULL.
 * - The client_id FK changes from ON DELETE SET NULL to NO ACTION: a NOT NULL
 *   column can't be SET NULL, and we want deleting a client that still owns
 *   workflows to be BLOCKED (the app reassigns to the default first). Tenant
 *   deletion still cascades cleanly (NO ACTION is checked at statement end, by
 *   which point the tenant's workflows + clients are all gone together).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- 1. new columns
    ALTER TABLE clients
      ADD COLUMN is_default boolean NOT NULL DEFAULT false,
      ADD COLUMN logo_url text;

    -- 2. at most ONE default client per tenant
    CREATE UNIQUE INDEX clients_default_per_tenant_uniq
      ON clients (tenant_id) WHERE is_default;

    -- 3. backfill: a default client (named after the tenant) for every tenant
    --    that doesn't already have one
    INSERT INTO clients (tenant_id, name, is_default)
    SELECT t.id, t.name, true
      FROM tenants t
     WHERE NOT EXISTS (
       SELECT 1 FROM clients c WHERE c.tenant_id = t.id AND c.is_default
     );

    -- 4. backfill: assign every unowned workflow to its tenant's default client
    UPDATE workflows w
       SET client_id = (
             SELECT c.id FROM clients c
              WHERE c.tenant_id = w.tenant_id AND c.is_default
           ),
           updated_at = now()
     WHERE w.client_id IS NULL;

    -- 5. recreate the client_id FK without ON DELETE SET NULL (-> NO ACTION)
    DO $$
    DECLARE fk text;
    BEGIN
      SELECT tc.constraint_name INTO fk
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
       WHERE tc.table_name = 'workflows'
         AND tc.constraint_type = 'FOREIGN KEY'
         AND kcu.column_name = 'client_id'
       LIMIT 1;
      IF fk IS NOT NULL THEN
        EXECUTE format('ALTER TABLE workflows DROP CONSTRAINT %I', fk);
      END IF;
    END $$;
    ALTER TABLE workflows
      ADD CONSTRAINT workflows_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients (id);

    -- 6. every workflow now has a home
    ALTER TABLE workflows ALTER COLUMN client_id SET NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE workflows ALTER COLUMN client_id DROP NOT NULL;

    -- restore the original ON DELETE SET NULL FK
    ALTER TABLE workflows DROP CONSTRAINT workflows_client_id_fkey;
    ALTER TABLE workflows
      ADD CONSTRAINT workflows_client_id_fkey
      FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL;

    -- remove the backfilled default clients (the SET NULL FK nulls their
    -- workflows' client_id, restoring the pre-migration unowned state)
    DELETE FROM clients WHERE is_default = true;

    DROP INDEX IF EXISTS clients_default_per_tenant_uniq;
    ALTER TABLE clients
      DROP COLUMN IF EXISTS is_default,
      DROP COLUMN IF EXISTS logo_url;
  `);
}
