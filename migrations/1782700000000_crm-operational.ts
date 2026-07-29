import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * C-3 operational CRM (recovered from the reverted PR #2, re-authored for today's HEAD).
 * Four additive tables + the timeline audit source. NO companies/deals/pipelines.
 *
 *  - contact_notes        — free-text notes on a person (soft-deleted via deleted_at).
 *  - crm_tasks            — follow-up tasks on a person.
 *  - contact_tags         — the per-client tag catalogue.
 *  - contact_tag_links    — many-to-many contact ↔ tag.
 *  - crm_activity_events  — append-only CRM-NATIVE facts (the timeline audit source).
 *
 * DIFFERENCES FROM PR #2:
 *  - It does NOT re-add `contacts_id_tenant_client_key` — C-2 (1782600000000) already
 *    created that composite unique, which the child composite FKs reference.
 *  - crm_tasks gains a (tenant_id, client_id, contact_id, created_at DESC) index: the
 *    timeline sorts tasks by created_at, which the PR #2 due_at index doesn't serve.
 *  - crm_activity_events accepts two more facts C-2/C-3 emit: `contact_merged`,
 *    `consent_changed`.
 *  - `up` DROPs the five tables first (defensive: robust to a stray table from an
 *    aborted local run — these tables are brand-new, so they never hold real data).
 *
 * crm_activity_events IS NOT A DUAL-WRITE LOG. It stores ONLY CRM-native facts that
 * have no other home: stage_changed, owner_changed, tag_added/removed, contact_merged,
 * consent_changed (and note_ and task_ which are AUDIT-ONLY — the timeline reads notes
 * and tasks from their own tables, never from here). Conversations and appointments
 * are NEVER copied in; getContactTimeline unions them from their own tables at read
 * time.
 *
 * INTEGRITY: every child carries tenant_id + client_id; the contact FK is COMPOSITE
 * (contact_id, tenant_id, client_id) → contacts (a mislinked cross-client row can't be
 * inserted); user columns use a composite FK to tenant_members(tenant_id,user_id) with
 * ON DELETE SET NULL(col) (PG15+) so history survives a member leaving.
 *
 * down drops the five tables (children first). It does NOT touch the C-2 contacts
 * constraint. Reversible (up→down→up tested).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- Defensive: clear any stray tables from an aborted local run (they are new — no
    -- real data ever lives here before this migration).
    DROP TABLE IF EXISTS crm_activity_events;
    DROP TABLE IF EXISTS contact_tag_links;
    DROP TABLE IF EXISTS contact_tags;
    DROP TABLE IF EXISTS crm_tasks;
    DROP TABLE IF EXISTS contact_notes;

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
    CREATE INDEX crm_tasks_open_due_idx ON crm_tasks (tenant_id, client_id, due_at) WHERE status = 'open';
    CREATE INDEX crm_tasks_assignee_open_idx ON crm_tasks (tenant_id, client_id, assigned_to_user_id, due_at) WHERE status = 'open';
    CREATE INDEX crm_tasks_contact_idx ON crm_tasks (tenant_id, client_id, contact_id, due_at);
    -- C-3: the timeline sorts tasks by created_at (the due_at index above doesn't serve it).
    CREATE INDEX crm_tasks_contact_created_idx ON crm_tasks (tenant_id, client_id, contact_id, created_at DESC);

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
      CONSTRAINT contact_tags_id_tenant_client_key UNIQUE (id, tenant_id, client_id)
    );
    CREATE UNIQUE INDEX contact_tags_client_name_uniq ON contact_tags (tenant_id, client_id, lower(name));

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
      CONSTRAINT contact_tag_links_uniq UNIQUE (contact_id, tag_id)
    );
    CREATE INDEX contact_tag_links_contact_idx ON contact_tag_links (tenant_id, client_id, contact_id);
    CREATE INDEX contact_tag_links_tag_idx ON contact_tag_links (tenant_id, client_id, tag_id);

    -- ── crm_activity_events (CRM-native facts; the timeline audit source) ─────
    CREATE TABLE crm_activity_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      event_type text NOT NULL CHECK (event_type IN (
        'note_created', 'note_updated', 'note_deleted',
        'task_created', 'task_completed', 'task_reopened', 'task_cancelled', 'task_assigned',
        'tag_added', 'tag_removed',
        'owner_changed', 'stage_changed', 'contact_merged', 'consent_changed'
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
  `);
}
