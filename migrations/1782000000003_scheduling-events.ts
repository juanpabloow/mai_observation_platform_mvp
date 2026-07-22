import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SCHED-3: `scheduling_events` — the append-only realtime feed. The platform has
 * no WebSocket; realtime is delivered by the existing POLL mechanism (the web
 * AutoRefresh + poll endpoints). Domain mutations write one row here AFTER the
 * transaction commits, and the agenda/contact poll endpoints read "events since
 * cursor" to drive live updates. If a client misses an event, a reload re-reads
 * the authoritative appointments/contacts tables (the events feed is a hint, not
 * the source of truth).
 *
 * event_type mirrors the contract: appointment.created / appointment.rescheduled /
 * appointment.cancelled / appointment.status_changed / schedule.changed. Scoped by
 * (tenant_id, site_id) so the agenda can subscribe per-site; contact realtime uses
 * the same feed filtered by the payload contact_id.
 *
 * A monotonically increasing bigint `seq` is the poll cursor (created_at can tie).
 * Fully reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE scheduling_events (
      seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id uuid NOT NULL DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      site_id uuid REFERENCES sites (id) ON DELETE CASCADE,
      event_type text NOT NULL CHECK (event_type IN (
        'appointment.created', 'appointment.rescheduled', 'appointment.cancelled',
        'appointment.status_changed', 'schedule.changed'
      )),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX scheduling_events_tenant_seq_idx ON scheduling_events (tenant_id, seq);
    CREATE INDEX scheduling_events_site_seq_idx ON scheduling_events (tenant_id, site_id, seq);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS scheduling_events;`);
}
