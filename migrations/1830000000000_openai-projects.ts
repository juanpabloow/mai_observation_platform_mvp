import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * COSTOS DE IA — split what OpenAI billed by business.
 *
 * `openai_projects`: the organization's projects (GET /v1/organization/projects), refreshed by
 * the billing sync, so the agency can pick them by name.
 *
 * `clients.openai_project_id`: the OpenAI project a business's bots use. A business with its own
 * project gets its billed cost EXACTLY (that project's line in the invoice); the rest of the
 * invoice (shared or unassigned projects) is split by n8n usage and marked approximate.
 * One project → at most one business (partial unique index). NULL = no own project.
 *
 * Additive and nullable. Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE openai_projects (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      project_id text NOT NULL CHECK (char_length(project_id) BETWEEN 1 AND 200),
      name text,
      status text,
      synced_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, project_id)
    );

    ALTER TABLE clients
      ADD COLUMN openai_project_id text
        CONSTRAINT clients_openai_project_id_check CHECK (openai_project_id IS NULL OR char_length(openai_project_id) BETWEEN 1 AND 200);
    CREATE UNIQUE INDEX clients_openai_project_unique
      ON clients (tenant_id, openai_project_id) WHERE openai_project_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX clients_openai_project_unique;
    ALTER TABLE clients DROP COLUMN openai_project_id;
    DROP TABLE openai_projects;
  `);
}
