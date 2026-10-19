import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * AT-2b — per-ad NAME + BOT NOTE (business configuration, like the campaign brief). The WhatsApp
 * referral never carries the Ads Manager ad NAME, and several ads share one headline, so an ad
 * needs a human label; bot_note is what's specific to THIS ad on top of its campaign brief (read
 * by AT-3). Both optional, both set only by a person — AT-1 ingestion's ON CONFLICT upsert already
 * touches only headline/body/source_url/media_type/seen timestamps, so these survive a later lead.
 *
 *  name     — free text, ≤200, non-blank when present (the Ads Manager name, e.g. "Factos Falla").
 *  bot_note — plain text, ≤500, non-blank when present.
 * Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE ads
      ADD COLUMN name text CHECK (name IS NULL OR (char_length(name) <= 200 AND btrim(name) <> '')),
      ADD COLUMN bot_note text CHECK (bot_note IS NULL OR (char_length(bot_note) <= 500 AND btrim(bot_note) <> ''));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE ads
      DROP COLUMN name,
      DROP COLUMN bot_note;
  `);
}
