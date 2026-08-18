import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * CONTACT COMMUNICATION PREFERENCES — the two columns the contact form's COMUNICACIÓN
 * section needs and the schema did not have. Additive and fully reversible.
 *
 * WHY THESE ARE NOT THE CONSENT COLUMNS. `messaging_consent` already exists and is
 * deliberately STORE-ONLY (C-2): it records what the person agreed to, and nothing in
 * the platform gates on it. `do_not_contact` is a different statement made by a
 * different party — the SHOP suppressing its own sends, not the customer's permission
 * — and the form shows them as two separate controls precisely because collapsing them
 * loses information: a contact can have consent on record AND be suppressed (a dispute,
 * a VIP who asked the front desk to stop the reminders), and re-enabling sends must not
 * silently re-assert a consent nobody gave. Keeping them apart is what makes each
 * reversible on its own.
 *
 * do_not_contact is the one NOT NULL addition. `NOT NULL DEFAULT false` is safe because
 * every row that exists today IS contactable — the default is a true statement about
 * existing data, not a guess. Nothing reads it yet: like consent, it is stored this
 * phase and the send paths adopt it when they exist. That is deliberate — a column the
 * UI can set but no sender honours would be a lie, so the form labels it as intent
 * ("Suprime todos los envíos") and the suppression lands with the sender.
 *
 * preferred_channel is NULLABLE with no default: NULL means "nobody chose", which is
 * genuinely different from "chose WhatsApp". A default would invent a preference for
 * every contact ever created by a workflow.
 *
 * ON THE CHECK CONSTRAINT. There is no channel-enablement model in this codebase —
 * `contacts.channel` is a free-text ORIGIN label ('whatsapp', 'booking form', 'manual')
 * that C-2 explicitly never branches on, and CLIENT_MODULE_KEYS is crm/scheduling/inbox,
 * not a channel list. So this constraint is the closed set the FORM offers, and it is
 * intentionally narrow: a typo can't reach the column, and adding a fifth channel is a
 * migration — which is the honest cost, because a fifth channel also needs a sender.
 */

/** The channels the contact form offers. A fifth entry means a migration AND a sender. */
const PREFERRED_CHANNELS = ['whatsapp', 'email', 'phone', 'sms'] as const;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE contacts
      -- NULL = no preference on record (NOT "WhatsApp by default").
      ADD COLUMN preferred_channel text,
      -- Suppression is the SHOP's decision; consent is the CUSTOMER's. See the note above.
      ADD COLUMN do_not_contact boolean NOT NULL DEFAULT false;

    ALTER TABLE contacts
      ADD CONSTRAINT contacts_preferred_channel_valid
        CHECK (preferred_channel IS NULL OR preferred_channel IN (${PREFERRED_CHANNELS.map((c) => `'${c}'`).join(', ')}));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE contacts DROP CONSTRAINT contacts_preferred_channel_valid;
    ALTER TABLE contacts
      DROP COLUMN preferred_channel,
      DROP COLUMN do_not_contact;
  `);
}
