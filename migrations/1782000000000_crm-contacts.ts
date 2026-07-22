import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * CRM-1: `contacts` — the canonical PERSON entity (distinct from a conversation).
 *
 * workflow_ref + conversation_ref identifies a CONVERSATION, not a person. A
 * person (contact) may have MANY conversations and MANY appointments. The
 * canonical identity is UNIQUE (tenant_id, channel, channel_user_id): for
 * WhatsApp channel_user_id is the wa_id (or the stablest available id); the phone
 * is normalized to E.164 in phone_e164 when known.
 *
 * conversations gains a nullable contact_id (FK → contacts, ON DELETE SET NULL —
 * deleting a contact must not delete conversation history, it just detaches). The
 * existing conversations identity (tenant_id, n8n_workflow_id, conversation_ref)
 * is preserved untouched.
 *
 * CLIENT SCOPING: a contact belongs to a client (a business within the tenant),
 * so the canonical identity is UNIQUE (tenant_id, client_id, channel,
 * channel_user_id). This matches the platform's tenant→client model (a member is
 * hard-scoped to one client), so a member only ever sees their client's contacts.
 *
 * SAFE BACKFILL (additive, no data loss): every existing conversation is grouped
 * by (tenant_id, client_id, conversation_ref) into ONE imported contact
 * (channel='imported', channel_user_id=conversation_ref) and linked, where the
 * client is resolved from the conversation's workflow (workflows.client_id),
 * falling back to the tenant's DEFAULT client. This treats the pre-CRM
 * conversation_ref as the best-available stable per-person id (for WhatsApp
 * single-user chats it usually IS the wa_id). Real channel/channel_user_id arrive
 * going forward via the scheduling API's resolve-or-create path.
 *
 * `stage` and `bot_human_mode` are stored defaults; the "is a customer" status is
 * DERIVED at read time (a contact with ≥1 completed appointment) — never a stored
 * flag. message_count is backfilled once from handoff_messages and maintained
 * best-effort thereafter.
 *
 * Fully reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE contacts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      channel text NOT NULL,
      channel_user_id text NOT NULL,
      phone_e164 text,
      name text,
      email text,
      bot_human_mode text NOT NULL DEFAULT 'bot' CHECK (bot_human_mode IN ('bot', 'human')),
      stage text NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'active', 'customer', 'archived')),
      assigned_to text REFERENCES "user" (id) ON DELETE SET NULL,
      first_contact_at timestamptz NOT NULL DEFAULT now(),
      last_contact_at timestamptz NOT NULL DEFAULT now(),
      message_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Canonical person identity: one contact per (tenant, client, channel, external id).
      UNIQUE (tenant_id, client_id, channel, channel_user_id),
      -- Same-tenant client reference (the composite unique on clients enables this).
      CONSTRAINT contacts_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id),
      CONSTRAINT contacts_phone_e164_format
        CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[1-9][0-9]{6,14}$')
    );
    CREATE INDEX contacts_tenant_client_idx ON contacts (tenant_id, client_id);
    CREATE INDEX contacts_tenant_client_phone_idx ON contacts (tenant_id, client_id, phone_e164);
    CREATE INDEX contacts_tenant_client_stage_idx ON contacts (tenant_id, client_id, stage);
    CREATE INDEX contacts_assigned_idx ON contacts (assigned_to);

    -- Attribution link: which contact a conversation belongs to (nullable; a
    -- conversation may exist before its contact is resolved).
    ALTER TABLE conversations
      ADD COLUMN contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL;
    CREATE INDEX conversations_contact_idx ON conversations (contact_id);

    -- Backfill: one imported contact per distinct (tenant, client, conversation_ref),
    -- where the client is the conversation's workflow client (or the tenant default).
    INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, first_contact_at, last_contact_at)
    SELECT m.tenant_id,
           m.client_id,
           'imported',
           m.conversation_ref,
           MIN(m.created_at),
           MAX(COALESCE(m.last_message_at, m.updated_at, m.created_at))
      FROM (
        SELECT c.tenant_id,
               c.conversation_ref,
               c.created_at,
               c.last_message_at,
               c.updated_at,
               COALESCE(w.client_id, dc.id) AS client_id
          FROM conversations c
          LEFT JOIN workflows w
            ON w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
          LEFT JOIN clients dc
            ON dc.tenant_id = c.tenant_id AND dc.is_default
      ) m
     WHERE m.client_id IS NOT NULL
     GROUP BY m.tenant_id, m.client_id, m.conversation_ref
    ON CONFLICT (tenant_id, client_id, channel, channel_user_id) DO NOTHING;

    -- Link every existing conversation to its imported contact (same client rule).
    UPDATE conversations conv
       SET contact_id = ct.id
      FROM (
        SELECT c.id AS conv_id,
               c.tenant_id,
               c.conversation_ref,
               COALESCE(w.client_id, dc.id) AS client_id
          FROM conversations c
          LEFT JOIN workflows w
            ON w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
          LEFT JOIN clients dc
            ON dc.tenant_id = c.tenant_id AND dc.is_default
      ) m
      JOIN contacts ct
        ON ct.tenant_id = m.tenant_id
       AND ct.client_id = m.client_id
       AND ct.channel = 'imported'
       AND ct.channel_user_id = m.conversation_ref
     WHERE conv.id = m.conv_id AND conv.contact_id IS NULL;

    -- Best-effort message_count backfill from the handoff message log.
    UPDATE contacts ct
       SET message_count = sub.cnt
      FROM (
        SELECT c.contact_id, COUNT(m.id)::int AS cnt
          FROM conversations c
          JOIN handoff_messages m ON m.conversation_id = c.id
         WHERE c.contact_id IS NOT NULL
         GROUP BY c.contact_id
      ) sub
     WHERE sub.contact_id = ct.id;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS conversations_contact_idx;
    ALTER TABLE conversations DROP COLUMN IF EXISTS contact_id;
    DROP TABLE IF EXISTS contacts;
  `);
}
