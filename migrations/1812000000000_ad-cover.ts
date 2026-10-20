import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * AT-2c — AD COVERS. Each ad can carry a cover image so the Ads tab is visual, plus the plain
 * links to open the creative on Facebook. Reversible.
 *
 *  cover_image_key     — the R2 object KEY (public bucket, "ads/…" prefix) of the stored cover; the
 *                        UI builds the public URL from it. NULL = no cover (a neutral placeholder).
 *  cover_source        — 'auto' (captured server-side from the Meta referral thumbnail/image) or
 *                        'manual' (a person uploaded it). A 'manual' cover is NEVER replaced by an
 *                        automatic capture.
 *  cover_updated_at     — when the current cover was stored (drives the auto-refresh period).
 *  cover_fetch_url      — the latest SIGNED Meta CDN url QUEUED for server-side capture. Written by
 *                        ingestion (the signed url is never fetched on the message hot path); the
 *                        worker cover-reconcile downloads it and clears it. Signed urls expire in
 *                        days, so…
 *  cover_fetch_seen_at  — …the MESSAGE time the url was seen; the reconcile only retries while it is
 *                        still fresh enough to be valid (a backfilled old referral is skipped).
 *  video_url            — a facebook.com story link (referral_video_url). A plain link, NEVER
 *                        fetched (it is not a media file and cannot play inside MAI).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE ads
      ADD COLUMN cover_image_key text CHECK (cover_image_key IS NULL OR (char_length(cover_image_key) <= 512 AND btrim(cover_image_key) <> '')),
      ADD COLUMN cover_source text CHECK (cover_source IS NULL OR cover_source IN ('auto', 'manual')),
      ADD COLUMN cover_updated_at timestamptz,
      ADD COLUMN cover_fetch_url text CHECK (cover_fetch_url IS NULL OR (char_length(cover_fetch_url) <= 2048 AND btrim(cover_fetch_url) <> '')),
      ADD COLUMN cover_fetch_seen_at timestamptz,
      ADD COLUMN video_url text CHECK (video_url IS NULL OR (char_length(video_url) <= 2048 AND btrim(video_url) <> ''));
    -- The worker cover-reconcile scans for ads with a queued fetch url (partial index: tiny).
    CREATE INDEX ads_cover_fetch_idx ON ads (tenant_id, client_id) WHERE cover_fetch_url IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS ads_cover_fetch_idx;
    ALTER TABLE ads
      DROP COLUMN cover_image_key,
      DROP COLUMN cover_source,
      DROP COLUMN cover_updated_at,
      DROP COLUMN cover_fetch_url,
      DROP COLUMN cover_fetch_seen_at,
      DROP COLUMN video_url;
  `);
}
