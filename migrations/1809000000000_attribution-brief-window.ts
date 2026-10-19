import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * AT-2 §3 — the per-client BRIEF WINDOW (days) the campaign brief applies for after an ad
 * touch. Stored now, read by AT-3; default 7 days. Lives on attribution_settings beside
 * tracking_started_at (the per-client agency settings that are NOT module-gated — capture runs
 * regardless of the campaigns module). NOT NULL DEFAULT 7 backfills every existing row, and
 * the existing INSERT ... ON CONFLICT upsert that writes only tracking_started_at keeps working
 * (the default fills brief_window_days). Bounded 1..90. Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE attribution_settings
      ADD COLUMN brief_window_days integer NOT NULL DEFAULT 7
        CHECK (brief_window_days BETWEEN 1 AND 90);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE attribution_settings DROP COLUMN brief_window_days;`);
}
