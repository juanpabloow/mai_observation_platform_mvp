import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * MOD-2: register `inbox` as a third per-client module (crm | scheduling | inbox).
 * A NEW migration — the original client_modules migration is left untouched.
 *
 * up:
 *   - widen the module_key CHECK to accept 'inbox';
 *   - backfill: ENABLE inbox for every EXISTING non-default client (preserves the
 *     prior always-on Inbox behavior); the default ("Unassigned") client is never
 *     enabled; ON CONFLICT DO NOTHING so it's re-runnable and doesn't clobber a row.
 *   NEW clients created after this migration start WITHOUT inbox until owner/admin
 *   enables it (no backfill runs for them).
 *
 * down (SAFE): refuses to run while any 'inbox' row exists (dropping the CHECK's
 * value would strand those rows / silently lose settings). Clear inbox rows first.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling', 'inbox'));

    -- Preserve the previous behavior (Inbox was always available) for EXISTING
    -- non-default clients. New clients start without it.
    INSERT INTO client_modules (tenant_id, client_id, module_key)
    SELECT c.tenant_id, c.id, 'inbox'
      FROM clients c
     WHERE c.is_default = false
    ON CONFLICT (tenant_id, client_id, module_key) DO NOTHING;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    DECLARE n integer;
    BEGIN
      SELECT count(*) INTO n FROM client_modules WHERE module_key = 'inbox';
      IF n > 0 THEN
        RAISE EXCEPTION
          'MOD-2 down aborted: % inbox client_modules row(s) exist. Delete them explicitly before rolling back (avoids silent data loss).', n;
      END IF;
    END $$;

    ALTER TABLE client_modules DROP CONSTRAINT client_modules_key_check;
    ALTER TABLE client_modules
      ADD CONSTRAINT client_modules_key_check
      CHECK (module_key IN ('crm', 'scheduling'));
  `);
}
