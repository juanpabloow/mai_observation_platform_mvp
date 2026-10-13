import type { MigrationBuilder } from 'node-pg-migrate';

/** Preserve complete service descriptions. This changes a CHECK only: no imports,
 * truncation, service updates or appointment changes. Run in the migration transaction.
 * A downgrade refuses to proceed while longer descriptions exist; it never shortens them. */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE services DROP CONSTRAINT services_description_len_check;
    ALTER TABLE services
      ADD CONSTRAINT services_description_len_check
      CHECK (description IS NULL OR (char_length(description) <= 2000 AND btrim(description) <> ''));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    LOCK TABLE services IN ACCESS EXCLUSIVE MODE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM services WHERE char_length(description) > 500) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot restore the 500-character limit while longer service descriptions exist. Review the data explicitly; no text was truncated.';
      END IF;
    END $$;
    ALTER TABLE services DROP CONSTRAINT services_description_len_check;
    ALTER TABLE services
      ADD CONSTRAINT services_description_len_check
      CHECK (description IS NULL OR (char_length(description) <= 500 AND btrim(description) <> ''));
  `);
}
