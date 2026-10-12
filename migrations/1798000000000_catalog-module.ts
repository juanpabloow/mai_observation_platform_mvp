import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * CATALOG-1: register the `catalog` module key (the "Productos" surface) — what a
 * business sells beyond its services, so the assistant can tell a customer what
 * exists, what it costs, what it is and whether it's available (INFORM ONLY).
 *
 * This migration adds NOTHING but the key; the `products` table lands in the next
 * migration (CATALOG-2). What the key buys is the ability to ENABLE the surface
 * per client — `client_modules` is the only switch the rail, the pages and the
 * machine API read, so without the key in the CHECK the module could not be turned
 * on at all.
 *
 * Mirrors MOD-3 (meetings): the CHECK is the schema-side mirror of the pure
 * registry in src/modules/registry.ts — keep the two in sync.
 *
 * NO BACKFILL. Catalog is brand-new, so every client starts WITHOUT it and an
 * operator (the agency) turns it on from Modules.
 *
 * down refuses to run while `catalog` rows exist, for the same reason MOD-3's does:
 * re-adding the narrower CHECK would fail on those rows, and silently deleting a
 * client's module settings to make a rollback succeed is worse than an explicit stop.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox', 'meetings', 'catalog'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n bigint;
    BEGIN
      SELECT count(*) INTO n FROM client_modules WHERE module_key = 'catalog';
      IF n > 0 THEN
        RAISE EXCEPTION
          'CATALOG-1 down aborted: % catalog client_modules row(s) exist. Delete them explicitly before rolling back (avoids silent data loss).', n;
      END IF;
    END $$;

    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox', 'meetings'));
  `);
}
