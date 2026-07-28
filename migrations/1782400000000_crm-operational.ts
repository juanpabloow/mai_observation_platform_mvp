import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * CRM-2 (operational CRM, phase 1 — B2C, built around `contacts`; NO companies /
 * deals / pipelines / custom properties). Four additive tables + one composite
 * unique on contacts:
 *
 *  - contact_notes         — free-text notes on a person (soft-deleted).
 *  - crm_tasks             — follow-up tasks on a person.
 *  - contact_tags          — the per-client tag catalogue.
 *  - contact_tag_links     — many-to-many contact ↔ tag.
 *  - crm_activity_events   — append-only audit/timeline of CRM actions.
 *
 * INTEGRITY (cross-client is a PostgreSQL guarantee, not just app code):
 *  - contacts gains UNIQUE (id, tenant_id, client_id) so children can reference it
 *    with a COMPOSITE FK (contact_id, tenant_id, client_id) → contacts. A note/task/
 *    tag-link whose (client_id) differs from the contact's is IMPOSSIBLE to insert.
 *  - every table carries tenant_id + client_id with (client_id, tenant_id) →
 *    clients(id, tenant_id) (same-tenant client).
 *  - author / assignee / actor columns use a COMPOSITE FK (tenant_id, <user>) →
 *    tenant_members(tenant_id, user_id): the user must be a member of THIS tenant.
 *    ON DELETE SET NULL (<user>) (PG15+ selective column list) preserves history
 *    when a member leaves — the row survives, the user pointer is nulled, tenant_id
 *    stays. All user columns are nullable (a null is unenforced under MATCH SIMPLE).
 *
 * SOFT DELETE DECISION: the codebase has no `deleted_at` convention (it soft-deletes
 * via status/active flags: appointments→'cancelled', contacts→'archived', sites/
 * services→active=false). Notes have no natural status, and an operational CRM
 * timeline benefits from keeping a deleted note for audit, so contact_notes uses a
 * `deleted_at` soft delete (reads filter deleted_at IS NULL; the note_deleted event
 * records the removal). Tasks use their `cancelled` status instead.
 *
 * down drops the four tables (children first) + the contacts unique — fully
 * reversible (tested up/down).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- Composite unique so contact children can reference (id, tenant_id, client_id).
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_id_tenant_client_key UNIQUE (id, tenant_id, client_id);

    -- ── contact_notes (soft-deleted) ──────────────────────────────────────────
    CREATE TABLE contact_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000),
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CONSTRAINT contact_notes_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id),
      CONSTRAINT contact_notes_contact_fkey FOREIGN KEY (contact_id, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT contact_notes_author_fkey FOREIGN KEY (tenant_id, created_by_user_id)
        REFERENCES tenant_members (tenant_id, user_id) ON DELETE SET NULL (created_by_user_id)
    );
    CREATE INDEX contact_notes_contact_idx
      ON contact_notes (tenant_id, client_id, contact_id, created_at DESC)
      WHERE deleted_at IS NULL;

    -- ── crm_tasks ─────────────────────────────────────────────────────────────
    CREATE TABLE crm_tasks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 300),
      description text CHECK (description IS NULL OR char_length(description) <= 10000),
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
      priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
      due_at timestamptz,
      assigned_to_user_id text,
      created_by_user_id text,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- completed_at is set iff status = 'completed' (kept consistent by the repo).
      CONSTRAINT crm_tasks_completed_consistency
        CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
      CONSTRAINT crm_tasks_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id),
      CONSTRAINT crm_tasks_contact_fkey FOREIGN KEY (contact_id, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT crm_tasks_assignee_fkey FOREIGN KEY (tenant_id, assigned_to_user_id)
        REFERENCES tenant_members (tenant_id, user_id) ON DELETE SET NULL (assigned_to_user_id),
      CONSTRAINT crm_tasks_author_fkey FOREIGN KEY (tenant_id, created_by_user_id)
        REFERENCES tenant_members (tenant_id, user_id) ON DELETE SET NULL (created_by_user_id)
    );
    -- Open tasks by client + due date (the "overdue / due today" queries).
    CREATE INDEX crm_tasks_open_due_idx
      ON crm_tasks (tenant_id, client_id, due_at)
      WHERE status = 'open';
    -- Open tasks by assignee (a member's queue).
    CREATE INDEX crm_tasks_assignee_open_idx
      ON crm_tasks (tenant_id, client_id, assigned_to_user_id, due_at)
      WHERE status = 'open';
    -- All tasks of a contact (the contact's Tasks tab + "next task").
    CREATE INDEX crm_tasks_contact_idx
      ON crm_tasks (tenant_id, client_id, contact_id, due_at);

    -- ── contact_tags (per-client catalogue) ───────────────────────────────────
    CREATE TABLE contact_tags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
      color text NOT NULL DEFAULT 'gray'
        CHECK (color IN ('gray', 'red', 'orange', 'amber', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT contact_tags_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id),
      -- Referenceable by contact_tag_links with a same-client composite FK.
      CONSTRAINT contact_tags_id_tenant_client_key UNIQUE (id, tenant_id, client_id)
    );
    -- Case-insensitive unique name PER CLIENT (two clients may reuse a name).
    CREATE UNIQUE INDEX contact_tags_client_name_uniq
      ON contact_tags (tenant_id, client_id, lower(name));

    -- ── contact_tag_links (contact ↔ tag) ─────────────────────────────────────
    CREATE TABLE contact_tag_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      tag_id uuid NOT NULL,
      created_by_user_id text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT contact_tag_links_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id),
      CONSTRAINT contact_tag_links_contact_fkey FOREIGN KEY (contact_id, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT contact_tag_links_tag_fkey FOREIGN KEY (tag_id, tenant_id, client_id)
        REFERENCES contact_tags (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT contact_tag_links_author_fkey FOREIGN KEY (tenant_id, created_by_user_id)
        REFERENCES tenant_members (tenant_id, user_id) ON DELETE SET NULL (created_by_user_id),
      -- Idempotent attach: one link per (contact, tag).
      CONSTRAINT contact_tag_links_uniq UNIQUE (contact_id, tag_id)
    );
    CREATE INDEX contact_tag_links_contact_idx ON contact_tag_links (tenant_id, client_id, contact_id);
    CREATE INDEX contact_tag_links_tag_idx ON contact_tag_links (tenant_id, client_id, tag_id);

    -- ── crm_activity_events (append-only audit / timeline source) ─────────────
    CREATE TABLE crm_activity_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      event_type text NOT NULL CHECK (event_type IN (
        'note_created', 'note_updated', 'note_deleted',
        'task_created', 'task_completed', 'task_reopened', 'task_cancelled', 'task_assigned',
        'tag_added', 'tag_removed',
        'owner_changed', 'stage_changed'
      )),
      actor_user_id text,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
      occurred_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT crm_activity_events_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id),
      CONSTRAINT crm_activity_events_contact_fkey FOREIGN KEY (contact_id, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT crm_activity_events_actor_fkey FOREIGN KEY (tenant_id, actor_user_id)
        REFERENCES tenant_members (tenant_id, user_id) ON DELETE SET NULL (actor_user_id)
    );
    CREATE INDEX crm_activity_events_timeline_idx
      ON crm_activity_events (tenant_id, client_id, contact_id, occurred_at DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE IF EXISTS crm_activity_events;
    DROP TABLE IF EXISTS contact_tag_links;
    DROP TABLE IF EXISTS contact_tags;
    DROP TABLE IF EXISTS crm_tasks;
    DROP TABLE IF EXISTS contact_notes;
    ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_id_tenant_client_key;
  `);
}
