import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SERVICE DESCRIPTIONS — cap `services.description` at 500 characters.
 *
 * The column already exists (scheduling-core created it as `description text`, nullable,
 * uncapped). This adds the data rule the feature needs:
 *   - NULL is allowed (no description);
 *   - otherwise ≤ 500 characters, and NOT blank — a whitespace-only value must be stored
 *     as NULL, never as '' or '   ' (the server normalizes it; this is the DB backstop).
 *
 * Plain text; no markup is implied or stripped here. Reversible: down() drops the CHECK
 * and leaves the column + its data untouched.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- Any existing blank/whitespace description becomes NULL so the non-blank CHECK applies
    -- cleanly to the current data.
    UPDATE services SET description = NULL WHERE description IS NOT NULL AND btrim(description) = '';

    ALTER TABLE services
      ADD CONSTRAINT services_description_len_check
      CHECK (description IS NULL OR (char_length(description) <= 500 AND btrim(description) <> ''));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE services DROP CONSTRAINT IF EXISTS services_description_len_check;
  `);
}
