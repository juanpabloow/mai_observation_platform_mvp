import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * AT-2: register the `campaigns` module key in the client_modules CHECK — the schema-side mirror
 * of CLIENT_MODULE_KEYS in src/modules/registry.ts. AT-1 added `campaigns` to the registry (for
 * capture) but NOT to this CHECK, so the module could not actually be ENABLED (client_modules is
 * the only switch the rail/pages/actions read). Without this, turning Campañas on fails with
 * client_modules_key_check. No backfill: every client starts without it; the agency turns it on
 * from Modules.
 *
 * down refuses while `campaigns` rows exist (re-adding the narrower CHECK would fail on them, and
 * silently deleting a client's module settings to make a rollback succeed is worse than a stop) —
 * mirrors the catalog/meetings module-key migrations.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox', 'meetings', 'catalog', 'campaigns'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM client_modules WHERE module_key = 'campaigns';
      IF n > 0 THEN
        RAISE EXCEPTION
          'AT-2 down aborted: % campaigns client_modules row(s) exist. Delete them explicitly before rolling back (avoids silent data loss).', n;
      END IF;
    END $$;

    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox', 'meetings', 'catalog'));
  `);
}
