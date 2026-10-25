import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * FIX-1 §2 — MONEY HISTORY IS NEVER DELETED BY A CASCADE.
 *
 * `payments.appointment_id` was ON DELETE CASCADE, so deleting an appointment would delete its
 * recorded payment (and its payment_lines). An appointment is terminal and has NO hard-delete path in
 * production (cancel is a status change), so this only ever fired on teardown — but it is a loaded gun:
 * any future "delete appointment" path would silently erase money. Switch it to NO ACTION (the default):
 * a payment can never disappear because its appointment was deleted; a bare appointment delete that
 * would orphan a payment is refused.
 *
 * `appointment_id` is NOT NULL, so SET NULL is not an option — NO ACTION / RESTRICT are. NO ACTION
 * (not RESTRICT) is deliberate: it is checked at END of statement, so TENANT/CLIENT teardown still
 * works — `payments.tenant_id → tenants ON DELETE CASCADE` removes the payments in the SAME statement
 * that cascades the appointments, leaving nothing to orphan. (RESTRICT is checked immediately and would
 * block the teardown.) The other money references are already safe: payment_lines → products/services/
 * staff are SET NULL (the line keeps its name/price/commission SNAPSHOT), and payments → contacts is
 * SET NULL (the contact hard-delete is additionally guarded in deleteContactAction).
 *
 * Reversible. Run through the dashboard pre-deploy step (CI green first).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE payments DROP CONSTRAINT payments_appointment_id_fkey;
    ALTER TABLE payments ADD CONSTRAINT payments_appointment_id_fkey
      FOREIGN KEY (appointment_id) REFERENCES appointments (id);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE payments DROP CONSTRAINT payments_appointment_id_fkey;
    ALTER TABLE payments ADD CONSTRAINT payments_appointment_id_fkey
      FOREIGN KEY (appointment_id) REFERENCES appointments (id) ON DELETE CASCADE;
  `);
}
