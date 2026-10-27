import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * JP-3 — store the WhatsApp USERNAME (e.g. "nanditho.66") as a DISPLAY/contact-point attribute on
 * the contact. It is NEVER an identity/match key (a username can change hands), so it is a plain
 * column, not a contact_identities row.
 *
 *  - `whatsapp_username`      text, stored WITHOUT the leading "@", length-capped (≤ 64).
 *  - `whatsapp_username_seen_at` timestamptz — when it was last seen on an inbound message / upsert.
 *  - The contacts search document gains the username (so the list is searchable by it). The GIN
 *    trigram index is rebuilt to match CONTACT_SEARCH_DOC byte-for-byte (contacts.ts).
 *  - A new crm_activity_events type 'whatsapp_username_changed' for the timeline ("Cambió su usuario
 *    de WhatsApp de @a a @b").
 *
 * Reversible.
 */
const EVENT_TYPES_BEFORE = `'note_created','note_updated','note_deleted','task_created','task_completed','task_reopened','task_cancelled','task_assigned','tag_added','tag_removed','owner_changed','stage_changed','contact_merged','consent_changed','origin_set','attribution_touch'`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE contacts
      ADD COLUMN whatsapp_username text
        CONSTRAINT contacts_whatsapp_username_len CHECK (whatsapp_username IS NULL OR char_length(whatsapp_username) BETWEEN 1 AND 64),
      ADD COLUMN whatsapp_username_seen_at timestamptz;

    -- Rebuild the search document index to include the username (kept byte-identical to
    -- CONTACT_SEARCH_DOC in src/db/repositories/contacts.ts, minus the \`c.\` alias).
    DROP INDEX IF EXISTS contacts_search_trgm_idx;
    CREATE INDEX contacts_search_trgm_idx ON contacts USING gin (
      (
        lower(
          coalesce(name, '') || ' ' ||
          coalesce(email, '') || ' ' ||
          coalesce(channel_user_id, '') || ' ' ||
          coalesce(phone_e164, '') || ' ' ||
          regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g') || ' ' ||
          coalesce(whatsapp_username, '')
        )
      ) gin_trgm_ops
    );

    ALTER TABLE crm_activity_events DROP CONSTRAINT crm_activity_events_event_type_check;
    ALTER TABLE crm_activity_events ADD CONSTRAINT crm_activity_events_event_type_check
      CHECK (event_type = ANY (ARRAY[${EVENT_TYPES_BEFORE},'whatsapp_username_changed']::text[]));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE crm_activity_events DROP CONSTRAINT crm_activity_events_event_type_check;
    ALTER TABLE crm_activity_events ADD CONSTRAINT crm_activity_events_event_type_check
      CHECK (event_type = ANY (ARRAY[${EVENT_TYPES_BEFORE}]::text[]));

    DROP INDEX IF EXISTS contacts_search_trgm_idx;
    CREATE INDEX contacts_search_trgm_idx ON contacts USING gin (
      (
        lower(
          coalesce(name, '') || ' ' ||
          coalesce(email, '') || ' ' ||
          coalesce(channel_user_id, '') || ' ' ||
          coalesce(phone_e164, '') || ' ' ||
          regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g')
        )
      ) gin_trgm_ops
    );

    ALTER TABLE contacts
      DROP COLUMN whatsapp_username_seen_at,
      DROP COLUMN whatsapp_username;
  `);
}
