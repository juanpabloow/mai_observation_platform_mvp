import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * JP-4 — editing an existing appointment (service change + time/staff correction) writes two new
 * audit events. Extend the appointment_events.event_type CHECK to allow them. Reversible.
 *
 * The realtime agenda feed (scheduling_events) is NOT touched — a service change / correction reuses
 * the existing 'appointment.rescheduled' ping (the agenda just refetches the row), so only the
 * user-visible audit trail needs the new, distinct types.
 */
const BEFORE = `'appointment_created','appointment_rescheduled','appointment_cancelled','appointment_confirmed','appointment_completed','appointment_no_show','manual_note','mode_changed','escalation'`;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_event_type_check;
    ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_event_type_check
      CHECK (event_type = ANY (ARRAY[${BEFORE},'appointment_service_changed','appointment_time_corrected']::text[]));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE appointment_events DROP CONSTRAINT appointment_events_event_type_check;
    ALTER TABLE appointment_events ADD CONSTRAINT appointment_events_event_type_check
      CHECK (event_type = ANY (ARRAY[${BEFORE}]::text[]));
  `);
}
