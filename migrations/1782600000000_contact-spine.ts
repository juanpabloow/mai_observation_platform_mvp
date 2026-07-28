import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * C-2 CONTACT SPINE: multi-identity contacts + merge + consent + owner + custom fields.
 *
 * Identity model (kills audit risk ②, "duplication by design"):
 *  - `contact_identities` holds every way a person can be recognised — a phone
 *    (E.164-normalized), an email (lowercased), or an opaque `external` id. UNIQUE
 *    (tenant, client, kind, value) makes the duplicate impossible at INSERT time: a
 *    WhatsApp wa_id and a typed booking phone normalize to the SAME phone value and so
 *    resolve to the SAME contact. `label` is the free-text origin hint ('whatsapp',
 *    'booking_form', …) — DISPLAYED, never branched on.
 *  - `contacts` gains UNIQUE (id, tenant_id, client_id) so child tables can carry a
 *    COMPOSITE FK (id, tenant, client) — same-tenant/-client integrity, and it unblocks
 *    the C-3 CRM child tables too.
 *  - The old UNIQUE (tenant, client, channel, channel_user_id) is DROPPED. We KEEP the
 *    `channel` + `channel_user_id` columns (no rename): `channel` now reads as the
 *    descriptive SOURCE (how a contact first arrived), `channel_user_id` stays a
 *    readable compat hint. Justification: nothing branches on `channel` (it's only
 *    stored/displayed), the C-1 GIN search index is defined byte-for-byte on an
 *    expression that includes `channel_user_id`/`phone_e164` (a rename would force an
 *    index rebuild), and fewer renames = a smaller future PR-#2 merge conflict.
 *
 * Also: consent (store-only), custom fields (client_field_definitions + contacts.custom_fields),
 * duplicate candidates, and a merge audit table.
 *
 * down reverses everything and restores the old unique (safe on a DB with no colliding
 * (channel, channel_user_id) rows — true right after up / in the up→down→up check).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- 1. Composite unique on contacts (enables composite child FKs) + drop old unique.
    ALTER TABLE contacts ADD CONSTRAINT contacts_id_tenant_client_key UNIQUE (id, tenant_id, client_id);
    ALTER TABLE contacts DROP CONSTRAINT contacts_tenant_id_client_id_channel_channel_user_id_key;

    -- 2. Consent (STORE-ONLY this phase — nothing gates on it) + custom fields blob.
    ALTER TABLE contacts
      ADD COLUMN messaging_consent text NOT NULL DEFAULT 'unknown'
        CONSTRAINT contacts_messaging_consent_check CHECK (messaging_consent IN ('unknown','opted_in','opted_out')),
      ADD COLUMN consent_updated_at timestamptz,
      ADD COLUMN consent_source text,
      ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'
        CONSTRAINT contacts_custom_fields_object CHECK (jsonb_typeof(custom_fields) = 'object');

    -- 3. contact_identities — the recognition spine.
    CREATE TABLE contact_identities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id uuid NOT NULL,
      kind text NOT NULL CONSTRAINT contact_identities_kind_check CHECK (kind IN ('phone','email','external')),
      value text NOT NULL,
      label text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT contact_identities_unique UNIQUE (tenant_id, client_id, kind, value),
      CONSTRAINT contact_identities_contact_fkey
        FOREIGN KEY (contact_id, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE
    );
    CREATE INDEX contact_identities_contact_idx ON contact_identities (tenant_id, client_id, contact_id);

    -- 4. duplicate_contact_candidates — detected collisions awaiting a human merge.
    CREATE TABLE duplicate_contact_candidates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      contact_id_keep uuid NOT NULL,
      contact_id_duplicate uuid NOT NULL,
      reason text,
      detected_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      CONSTRAINT dup_candidate_pair_unique UNIQUE (tenant_id, client_id, contact_id_keep, contact_id_duplicate),
      CONSTRAINT dup_candidate_keep_fkey
        FOREIGN KEY (contact_id_keep, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT dup_candidate_dupe_fkey
        FOREIGN KEY (contact_id_duplicate, tenant_id, client_id)
        REFERENCES contacts (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT dup_candidate_distinct CHECK (contact_id_keep <> contact_id_duplicate)
    );
    CREATE INDEX dup_candidate_open_idx ON duplicate_contact_candidates (tenant_id, client_id) WHERE resolved_at IS NULL;

    -- 5. contact_merges — audit trail (no FK to contacts: the dropped contact is deleted;
    -- the JSON snapshot is what lets a human reverse a merge manually).
    CREATE TABLE contact_merges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      kept_contact_id uuid NOT NULL,
      dropped_contact_id uuid NOT NULL,
      merged_by text REFERENCES "user" (id) ON DELETE SET NULL,
      merged_at timestamptz NOT NULL DEFAULT now(),
      dropped_snapshot jsonb NOT NULL
    );
    CREATE INDEX contact_merges_idx ON contact_merges (tenant_id, client_id, merged_at DESC);

    -- 6. client_field_definitions — the CRM analogue of field mappings.
    CREATE TABLE client_field_definitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      entity text NOT NULL DEFAULT 'contact' CONSTRAINT cfd_entity_check CHECK (entity IN ('contact')),
      key text NOT NULL,
      label text NOT NULL,
      type text NOT NULL CONSTRAINT cfd_type_check CHECK (type IN ('text','number','date','select','boolean')),
      options jsonb,
      position integer NOT NULL DEFAULT 0,
      enabled boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cfd_key_unique UNIQUE (tenant_id, client_id, entity, key),
      CONSTRAINT cfd_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE
    );
    CREATE INDEX cfd_list_idx ON client_field_definitions (tenant_id, client_id, entity, position);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE IF EXISTS client_field_definitions;
    DROP TABLE IF EXISTS contact_merges;
    DROP TABLE IF EXISTS duplicate_contact_candidates;
    DROP TABLE IF EXISTS contact_identities;

    ALTER TABLE contacts
      DROP COLUMN IF EXISTS custom_fields,
      DROP COLUMN IF EXISTS consent_source,
      DROP COLUMN IF EXISTS consent_updated_at,
      DROP COLUMN IF EXISTS messaging_consent;

    -- Restore the pre-C-2 unique. Safe when no two contacts share (channel,
    -- channel_user_id) — true immediately after up and in the up→down→up check.
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_tenant_id_client_id_channel_channel_user_id_key
      UNIQUE (tenant_id, client_id, channel, channel_user_id);
    ALTER TABLE contacts DROP CONSTRAINT contacts_id_tenant_client_key;
  `);
}
