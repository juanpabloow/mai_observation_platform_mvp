import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Tenant-aware remodel. Splits the overloaded `clients` table into 4 clean,
 * tenant-scoped concepts:
 *
 *   tenants            — the top-level account.
 *   n8n_connections    — an n8n instance (base_url + encrypted key). This is
 *                        what the OLD `clients` table actually was; its rows
 *                        move here (ids preserved).
 *   clients (NEW)      — a logical group of workflows (no connection details).
 *   workflows          — synced from n8n, each optionally assigned to one client.
 *
 * executions / ingestion_state / field_mappings: gain tenant_id and have their
 * old `client_id` (which always meant "which n8n connection") renamed to
 * n8n_connection_id. Executions resolve to a client THROUGH the workflow, so we
 * deliberately do NOT denormalize client_id onto executions.
 *
 * Existing data is preserved: all rows are stamped with a default tenant, and
 * `workflows` is backfilled from the distinct workflow ids already in executions.
 * The whole migration runs in one transaction (atomic).
 */

// Fixed id for the default tenant so the data migration can reference it.
const DEFAULT_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const DEFAULT_TENANT_NAME = 'MAI';

export async function up(pgm: MigrationBuilder): Promise<void> {
  // --- 1. tenants + default tenant + n8n_connections (from old clients) ---
  pgm.sql(`
    CREATE TABLE tenants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO tenants (id, name) VALUES ('${DEFAULT_TENANT_ID}', '${DEFAULT_TENANT_NAME}');

    CREATE TABLE n8n_connections (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      name text NOT NULL,
      n8n_base_url text NOT NULL,
      n8n_api_key_encrypted text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX n8n_connections_tenant_id_index ON n8n_connections (tenant_id);

    -- Move existing clients into n8n_connections, PRESERVING ids so the existing
    -- executions/ingestion_state/field_mappings foreign keys stay valid.
    INSERT INTO n8n_connections
      (id, tenant_id, name, n8n_base_url, n8n_api_key_encrypted, is_active, created_at, updated_at)
    SELECT id, '${DEFAULT_TENANT_ID}', name, n8n_base_url, n8n_api_key_encrypted, is_active, created_at, updated_at
      FROM clients;
  `);

  // --- 2. executions: add tenant_id, client_id -> n8n_connection_id, repoint ---
  pgm.sql(`
    ALTER TABLE executions ADD COLUMN tenant_id uuid;
    UPDATE executions SET tenant_id = '${DEFAULT_TENANT_ID}';
    ALTER TABLE executions ALTER COLUMN tenant_id SET NOT NULL;

    ALTER TABLE executions DROP CONSTRAINT executions_client_id_fkey;
    ALTER TABLE executions RENAME COLUMN client_id TO n8n_connection_id;
    ALTER TABLE executions
      RENAME CONSTRAINT executions_client_id_n8n_execution_id_key
                     TO executions_n8n_connection_id_n8n_execution_id_key;
    ALTER TABLE executions
      ADD CONSTRAINT executions_n8n_connection_id_fkey
        FOREIGN KEY (n8n_connection_id) REFERENCES n8n_connections (id) ON DELETE CASCADE,
      ADD CONSTRAINT executions_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE;

    DROP INDEX executions_client_id_started_at_index;
    DROP INDEX executions_client_id_status_index;
    DROP INDEX executions_client_id_n8n_workflow_id_index;
    CREATE INDEX executions_n8n_connection_id_started_at_index ON executions (n8n_connection_id, started_at DESC);
    CREATE INDEX executions_n8n_connection_id_status_index ON executions (n8n_connection_id, status);
    CREATE INDEX executions_n8n_connection_id_n8n_workflow_id_index ON executions (n8n_connection_id, n8n_workflow_id);
    CREATE INDEX executions_tenant_id_started_at_index ON executions (tenant_id, started_at DESC);
  `);

  // --- 3. ingestion_state: add tenant_id, client_id -> n8n_connection_id ---
  pgm.sql(`
    ALTER TABLE ingestion_state ADD COLUMN tenant_id uuid;
    UPDATE ingestion_state SET tenant_id = '${DEFAULT_TENANT_ID}';
    ALTER TABLE ingestion_state ALTER COLUMN tenant_id SET NOT NULL;

    ALTER TABLE ingestion_state DROP CONSTRAINT ingestion_state_client_id_fkey;
    ALTER TABLE ingestion_state RENAME COLUMN client_id TO n8n_connection_id;
    ALTER TABLE ingestion_state
      ADD CONSTRAINT ingestion_state_n8n_connection_id_fkey
        FOREIGN KEY (n8n_connection_id) REFERENCES n8n_connections (id) ON DELETE CASCADE,
      ADD CONSTRAINT ingestion_state_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE;
  `);

  // --- 4. field_mappings: add tenant_id, client_id -> n8n_connection_id ---
  pgm.sql(`
    ALTER TABLE field_mappings ADD COLUMN tenant_id uuid;
    UPDATE field_mappings SET tenant_id = '${DEFAULT_TENANT_ID}';
    ALTER TABLE field_mappings ALTER COLUMN tenant_id SET NOT NULL;

    ALTER TABLE field_mappings DROP CONSTRAINT field_mappings_client_id_fkey;
    ALTER TABLE field_mappings RENAME COLUMN client_id TO n8n_connection_id;
    ALTER TABLE field_mappings
      ADD CONSTRAINT field_mappings_n8n_connection_id_fkey
        FOREIGN KEY (n8n_connection_id) REFERENCES n8n_connections (id) ON DELETE CASCADE,
      ADD CONSTRAINT field_mappings_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE;

    DROP INDEX field_mappings_client_id_n8n_workflow_id_index;
    CREATE INDEX field_mappings_n8n_connection_id_n8n_workflow_id_index
      ON field_mappings (n8n_connection_id, n8n_workflow_id);
  `);

  // --- 5. retire the OLD clients table, create the NEW clients table ---
  // Safe to drop now: all FKs that pointed at it were repointed above.
  pgm.sql(`
    DROP TABLE clients;

    CREATE TABLE clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX clients_tenant_id_index ON clients (tenant_id);
  `);

  // --- 6. workflows + backfill from distinct executions ---
  pgm.sql(`
    CREATE TABLE workflows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      n8n_connection_id uuid NOT NULL REFERENCES n8n_connections (id) ON DELETE CASCADE,
      n8n_workflow_id text NOT NULL,
      name text,
      client_id uuid REFERENCES clients (id) ON DELETE SET NULL,
      active boolean,
      last_synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT workflows_n8n_connection_id_n8n_workflow_id_key
        UNIQUE (n8n_connection_id, n8n_workflow_id)
    );
    CREATE INDEX workflows_tenant_id_index ON workflows (tenant_id);
    CREATE INDEX workflows_client_id_index ON workflows (client_id);

    -- Backfill one row per distinct (connection, workflow) seen in executions;
    -- name taken from the most recent execution; client_id left unassigned.
    INSERT INTO workflows (tenant_id, n8n_connection_id, n8n_workflow_id, name)
    SELECT DISTINCT ON (e.n8n_connection_id, e.n8n_workflow_id)
           e.tenant_id, e.n8n_connection_id, e.n8n_workflow_id, e.workflow_name
      FROM executions e
     ORDER BY e.n8n_connection_id, e.n8n_workflow_id, e.started_at DESC;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Reverse the remodel: restore the original single `clients` table (with the
  // connection details) and the original client_id columns/indexes/FKs. Executions
  // are preserved; the tenants/workflows/new-clients data is discarded.

  // 1. Drop the new tables that depend on others.
  pgm.sql(`DROP TABLE workflows;`);
  pgm.sql(`DROP TABLE clients;`);

  // 2. Recreate the OLD clients table and repopulate from n8n_connections.
  pgm.sql(`
    CREATE TABLE clients (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      n8n_base_url text NOT NULL,
      n8n_api_key_encrypted text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO clients (id, name, n8n_base_url, n8n_api_key_encrypted, is_active, created_at, updated_at)
    SELECT id, name, n8n_base_url, n8n_api_key_encrypted, is_active, created_at, updated_at
      FROM n8n_connections;
  `);

  // 3. field_mappings back to client_id.
  pgm.sql(`
    ALTER TABLE field_mappings DROP CONSTRAINT field_mappings_tenant_id_fkey;
    ALTER TABLE field_mappings DROP CONSTRAINT field_mappings_n8n_connection_id_fkey;
    DROP INDEX field_mappings_n8n_connection_id_n8n_workflow_id_index;
    ALTER TABLE field_mappings RENAME COLUMN n8n_connection_id TO client_id;
    ALTER TABLE field_mappings DROP COLUMN tenant_id;
    ALTER TABLE field_mappings
      ADD CONSTRAINT field_mappings_client_id_fkey
        FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE;
    CREATE INDEX field_mappings_client_id_n8n_workflow_id_index
      ON field_mappings (client_id, n8n_workflow_id);
  `);

  // 4. ingestion_state back to client_id.
  pgm.sql(`
    ALTER TABLE ingestion_state DROP CONSTRAINT ingestion_state_tenant_id_fkey;
    ALTER TABLE ingestion_state DROP CONSTRAINT ingestion_state_n8n_connection_id_fkey;
    ALTER TABLE ingestion_state RENAME COLUMN n8n_connection_id TO client_id;
    ALTER TABLE ingestion_state DROP COLUMN tenant_id;
    ALTER TABLE ingestion_state
      ADD CONSTRAINT ingestion_state_client_id_fkey
        FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE;
  `);

  // 5. executions back to client_id.
  pgm.sql(`
    ALTER TABLE executions DROP CONSTRAINT executions_tenant_id_fkey;
    ALTER TABLE executions DROP CONSTRAINT executions_n8n_connection_id_fkey;
    DROP INDEX executions_n8n_connection_id_started_at_index;
    DROP INDEX executions_n8n_connection_id_status_index;
    DROP INDEX executions_n8n_connection_id_n8n_workflow_id_index;
    DROP INDEX executions_tenant_id_started_at_index;
    ALTER TABLE executions
      RENAME CONSTRAINT executions_n8n_connection_id_n8n_execution_id_key
                     TO executions_client_id_n8n_execution_id_key;
    ALTER TABLE executions RENAME COLUMN n8n_connection_id TO client_id;
    ALTER TABLE executions DROP COLUMN tenant_id;
    ALTER TABLE executions
      ADD CONSTRAINT executions_client_id_fkey
        FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE CASCADE;
    CREATE INDEX executions_client_id_started_at_index ON executions (client_id, started_at DESC);
    CREATE INDEX executions_client_id_status_index ON executions (client_id, status);
    CREATE INDEX executions_client_id_n8n_workflow_id_index ON executions (client_id, n8n_workflow_id);
  `);

  // 6. Drop n8n_connections and tenants.
  pgm.sql(`DROP TABLE n8n_connections;`);
  pgm.sql(`DROP TABLE tenants;`);
}
