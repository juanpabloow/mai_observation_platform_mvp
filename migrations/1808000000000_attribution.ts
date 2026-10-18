import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * AT-1 — LEAD ORIGIN: data model for attribution (where every lead came from, as a FACT).
 * Generic: nothing names a specific business or channel. All domain rows are tenant_id +
 * client_id scoped with the composite FK `(client_id, tenant_id) → clients(id, tenant_id)`.
 *
 *  campaigns   — table only in AT-1 (the UI/writes come in AT-2). The FK target so ads can
 *                carry a campaign_id now, though nothing writes it this phase.
 *  ads         — one row per ad/post SEEN (platform meta; source_type ad|post; external_id =
 *                the referral_source_id). Unique per (client, platform, source_type,
 *                external_id). is_test is DERIVED (generated) from a "TEST-" prefix, so a test
 *                ad can never be mis-flagged and never counts in a metric by default.
 *  attribution_touches — one per inbound message that carried a referral. message_id is UNIQUE
 *                (a replayed message makes no second touch). ctwa_clid is stored because Meta's
 *                click id cannot be recovered later (a future phase sends conversions back).
 *  contacts.*  — origin stored WITH provenance: origin_kind (closed set), first/latest touch,
 *                origin_set_at/by, and origin_ref_contact_id (the BOOKER's contact for a
 *                booked_by_contact origin — a fact recorded at creation, no new relation table).
 *  attribution_settings — per-client tracking_started_at. Lives OUTSIDE client_modules on
 *                purpose: capture runs regardless of the (off-by-default) campaigns module, so
 *                the setting that dates "before capture = proves nothing" must not be module-gated.
 *
 * crm_activity_events gains two event types (origin_set, attribution_touch) so every origin
 * assignment and touch shows on the contact timeline.
 *
 * Reversible. DOWN removes the whole subsystem (and its captured data — expected for a schema
 * rollback) and restores the original event_type CHECK.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE campaigns (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      name text NOT NULL CHECK (char_length(name) <= 200 AND btrim(name) <> ''),
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
      start_date date,
      end_date date,
      external_campaign_id text CHECK (external_campaign_id IS NULL OR (char_length(external_campaign_id) <= 200 AND btrim(external_campaign_id) <> '')),
      target_service_id uuid REFERENCES services (id),
      promotion_id uuid REFERENCES promotions (id),
      bot_brief text CHECK (bot_brief IS NULL OR (char_length(bot_brief) <= 1500 AND btrim(bot_brief) <> '')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT campaigns_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
      CONSTRAINT campaigns_date_range CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date)
    );
    CREATE INDEX campaigns_client_idx ON campaigns (tenant_id, client_id, status);

    CREATE TABLE ads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      platform text NOT NULL CHECK (platform IN ('meta')),
      source_type text NOT NULL CHECK (source_type IN ('ad', 'post')),
      external_id text NOT NULL CHECK (char_length(external_id) <= 200 AND btrim(external_id) <> ''),
      headline text CHECK (headline IS NULL OR char_length(headline) <= 500),
      body text CHECK (body IS NULL OR char_length(body) <= 2000),
      source_url text CHECK (source_url IS NULL OR char_length(source_url) <= 2048),
      media_type text CHECK (media_type IS NULL OR char_length(media_type) <= 50),
      campaign_id uuid REFERENCES campaigns (id),
      -- DERIVED, never written: a test ad is one whose external_id starts with "TEST-".
      is_test boolean NOT NULL GENERATED ALWAYS AS (external_id LIKE 'TEST-%') STORED,
      first_seen_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT ads_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
      CONSTRAINT ads_unique UNIQUE (client_id, platform, source_type, external_id)
    );
    CREATE INDEX ads_client_idx ON ads (tenant_id, client_id, is_test);

    ALTER TABLE contacts
      ADD COLUMN origin_kind text CHECK (origin_kind IS NULL OR origin_kind IN (
        'meta_ad', 'meta_post', 'organic_whatsapp', 'booking_page', 'booked_by_contact', 'import', 'manual', 'unknown')),
      ADD COLUMN first_touch_id uuid,
      ADD COLUMN latest_touch_id uuid,
      ADD COLUMN origin_set_at timestamptz,
      -- 'system' or a user id (free text; a user id is text in this schema, and 'system' is not a user).
      ADD COLUMN origin_set_by text CHECK (origin_set_by IS NULL OR char_length(origin_set_by) <= 255),
      ADD COLUMN origin_ref_contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL;

    CREATE TABLE attribution_touches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
      conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
      message_id uuid NOT NULL REFERENCES handoff_messages (id) ON DELETE CASCADE,
      ad_id uuid NOT NULL REFERENCES ads (id),
      ctwa_clid text CHECK (ctwa_clid IS NULL OR char_length(ctwa_clid) <= 512),
      occurred_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attribution_touches_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
      CONSTRAINT attribution_touches_message_unique UNIQUE (message_id)
    );
    CREATE INDEX attribution_touches_contact_idx ON attribution_touches (tenant_id, client_id, contact_id, occurred_at);
    CREATE INDEX attribution_touches_ad_idx ON attribution_touches (tenant_id, client_id, ad_id, occurred_at);

    -- Cross-FKs added after attribution_touches exists (contacts ↔ touches is circular).
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_first_touch_fkey FOREIGN KEY (first_touch_id) REFERENCES attribution_touches (id) ON DELETE SET NULL,
      ADD CONSTRAINT contacts_latest_touch_fkey FOREIGN KEY (latest_touch_id) REFERENCES attribution_touches (id) ON DELETE SET NULL;

    CREATE TABLE attribution_settings (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      tracking_started_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, client_id),
      CONSTRAINT attribution_settings_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id)
    );
    -- Default: the moment this phase deploys. Existing clients start capturing immediately;
    -- the agency can change it (AT-1 server action). A client with no row = tracking not
    -- started (every no-referral contact is 'unknown', the conservative default).
    INSERT INTO attribution_settings (tenant_id, client_id, tracking_started_at)
      SELECT tenant_id, id, now() FROM clients
    ON CONFLICT (tenant_id, client_id) DO NOTHING;

    ALTER TABLE crm_activity_events DROP CONSTRAINT crm_activity_events_event_type_check;
    ALTER TABLE crm_activity_events ADD CONSTRAINT crm_activity_events_event_type_check CHECK (event_type IN (
      'note_created', 'note_updated', 'note_deleted',
      'task_created', 'task_completed', 'task_reopened', 'task_cancelled', 'task_assigned',
      'tag_added', 'tag_removed', 'owner_changed', 'stage_changed', 'contact_merged', 'consent_changed',
      'origin_set', 'attribution_touch'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE crm_activity_events DROP CONSTRAINT crm_activity_events_event_type_check;
    DELETE FROM crm_activity_events WHERE event_type IN ('origin_set', 'attribution_touch');
    ALTER TABLE crm_activity_events ADD CONSTRAINT crm_activity_events_event_type_check CHECK (event_type IN (
      'note_created', 'note_updated', 'note_deleted',
      'task_created', 'task_completed', 'task_reopened', 'task_cancelled', 'task_assigned',
      'tag_added', 'tag_removed', 'owner_changed', 'stage_changed', 'contact_merged', 'consent_changed'));

    DROP TABLE attribution_settings;
    ALTER TABLE contacts
      DROP CONSTRAINT contacts_first_touch_fkey,
      DROP CONSTRAINT contacts_latest_touch_fkey;
    DROP TABLE attribution_touches;
    ALTER TABLE contacts
      DROP COLUMN origin_kind,
      DROP COLUMN first_touch_id,
      DROP COLUMN latest_touch_id,
      DROP COLUMN origin_set_at,
      DROP COLUMN origin_set_by,
      DROP COLUMN origin_ref_contact_id;
    DROP TABLE ads;
    DROP TABLE campaigns;
  `);
}
