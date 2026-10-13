import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * STAFF PUBLIC PROFILE — what the public booking page (/book/{slug}) may show about a
 * professional beyond their name: a short public title, a presentation and a photo.
 *
 * Additive and opt-in: three NULLABLE columns with no default, so no existing row
 * changes and every existing INSERT keeps working. NULL means "not published": the
 * page then shows initials and no text. Nothing is copied from the private fields —
 * `title` (the internal role) and the PII columns stay where they are and are never
 * read by the public catalogue.
 *
 *  - public_title       ≤ 60 chars, not blank ("Barbero profesional").
 *  - public_bio         ≤ 600 chars, not blank. Plain text; the app also refuses links
 *                       and control characters before writing (web/lib/staffPublicProfile.ts).
 *  - public_photo_url   https only, ≤ 1024 chars. Written only by the upload action,
 *                       which stores the file in the platform's own bucket.
 *
 * DOWN refuses while any profile is filled in: dropping the columns would silently
 * delete approved presentations. Clear them explicitly first if a rollback is really
 * wanted. Runs inside the migration transaction.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE staff
      ADD COLUMN public_title text,
      ADD COLUMN public_bio text,
      ADD COLUMN public_photo_url text;
    ALTER TABLE staff
      ADD CONSTRAINT staff_public_title_check
        CHECK (public_title IS NULL OR (char_length(public_title) <= 60 AND btrim(public_title) <> '')),
      ADD CONSTRAINT staff_public_bio_check
        CHECK (public_bio IS NULL OR (char_length(public_bio) <= 600 AND btrim(public_bio) <> '')),
      ADD CONSTRAINT staff_public_photo_url_check
        CHECK (public_photo_url IS NULL OR (char_length(public_photo_url) <= 1024 AND public_photo_url ~ '^https://[^[:space:]]+$'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    LOCK TABLE staff IN ACCESS EXCLUSIVE MODE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM staff WHERE public_title IS NOT NULL OR public_bio IS NOT NULL OR public_photo_url IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot drop the staff public profile while profiles are filled in. Review and clear them explicitly; nothing was deleted.';
      END IF;
    END $$;
    ALTER TABLE staff
      DROP CONSTRAINT staff_public_photo_url_check,
      DROP CONSTRAINT staff_public_bio_check,
      DROP CONSTRAINT staff_public_title_check;
    ALTER TABLE staff
      DROP COLUMN public_photo_url,
      DROP COLUMN public_bio,
      DROP COLUMN public_title;
  `);
}
