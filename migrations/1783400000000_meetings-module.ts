import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MOD-3: register the `meetings` module key (the "Reuniones" surface).
 *
 * This migration adds NOTHING but the key. There is no meetings table yet: the
 * module's screens ship first against fixtures (web/lib/meetingsData.ts) so the
 * visual spec can be reviewed in the real shell, and the storage lands in a
 * later phase. What the key buys today is the ability to ENABLE the surface per
 * client — `client_modules` is the only switch the rail and the route read, so
 * without the key in the CHECK the module could not be turned on at all.
 *
 * Mirrors MOD-2 (inbox): the CHECK is the schema-side mirror of the pure
 * registry in src/modules/registry.ts — keep the two in sync.
 *
 * NO BACKFILL. Inbox backfilled because it had previously been always-on and
 * existing clients would otherwise have lost it. Reuniones is new, so every
 * client starts WITHOUT it and an operator turns it on from Modules.
 *
 * down refuses to run while `meetings` rows exist, for the same reason MOD-2's
 * does: re-adding the narrower CHECK would fail on those rows, and silently
 * deleting a client's module settings to make a rollback succeed is worse than
 * an explicit stop.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox', 'meetings'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM client_modules WHERE module_key = 'meetings';
      IF n > 0 THEN
        RAISE EXCEPTION
          'MOD-3 down aborted: % meetings client_modules row(s) exist. Delete them explicitly before rolling back (avoids silent data loss).', n;
      END IF;
    END $$;

    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox'));
  `);
}
