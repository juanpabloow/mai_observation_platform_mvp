import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SCHED-2: appointments + the DATABASE-ENFORCED anti-double-book guarantee, plus
 * the appointment_events audit trail.
 *
 * Anti double-book: a GiST EXCLUSION CONSTRAINT (needs btree_gist for the uuid
 * equality operator) forbids two ACTIVE (scheduled|confirmed) appointments for the
 * same staff member whose blocked ranges overlap. Two concurrent inserts for the
 * same staff+slot ⇒ exactly ONE commits; the other raises SQLSTATE 23P01, which
 * the booking service maps to HTTP 409. This is NOT a SELECT-then-INSERT check —
 * the guarantee lives in Postgres.
 *
 * Time model: the CUSTOMER-VISIBLE appointment is [start_at, service_end_at); the
 * interval used for overlap (service + buffers) is [blocked_from, blocked_until).
 * blocked_from ≤ start_at and blocked_until ≥ service_end_at (CHECK).
 *
 * Snapshots: service_name/duration/price/buffers are COPIED onto the row at
 * booking time so later edits to the service catalogue never mutate historical
 * appointments.
 *
 * Idempotency: UNIQUE (tenant_id, idempotency_key) (partial, key NOT NULL) — a
 * retried POST with the same key+payload returns the existing appointment; a
 * reused key with a different payload is a conflict (enforced in the service).
 *
 * public_reference: a non-sequential uuid safe to expose in public URLs / to the
 * customer (never the internal id).
 *
 * Cancelling never deletes — status → 'cancelled'. Rescheduling keeps the same id,
 * moves the interval in a transaction, bumps version, and writes an event.
 *
 * Fully reversible (the extension is left in place on down — dropping a shared
 * extension could break other objects).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS btree_gist;

    CREATE TABLE appointments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      public_reference uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      -- Denormalized from the site's client for authorization filtering + indexes
      -- (a member sees only their client's appointments). Same-tenant enforced via
      -- the composite FK to clients.
      client_id uuid NOT NULL,
      site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL,
      source_conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL,
      staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,

      start_at timestamptz NOT NULL,
      service_end_at timestamptz NOT NULL,
      blocked_from timestamptz NOT NULL,
      blocked_until timestamptz NOT NULL,

      service_name_snapshot text NOT NULL,
      duration_min_snapshot integer NOT NULL CHECK (duration_min_snapshot > 0),
      price_snapshot numeric(10, 2),
      buffer_before_min_snapshot integer NOT NULL DEFAULT 0 CHECK (buffer_before_min_snapshot >= 0),
      buffer_after_min_snapshot integer NOT NULL DEFAULT 0 CHECK (buffer_after_min_snapshot >= 0),

      status text NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
      origin text NOT NULL
        CHECK (origin IN ('public', 'n8n', 'internal', 'walk_in')),
      created_by_type text NOT NULL
        CHECK (created_by_type IN ('system', 'agent', 'public', 'n8n')),
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      idempotency_key text,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT appointments_service_range CHECK (service_end_at > start_at),
      CONSTRAINT appointments_blocked_range CHECK (blocked_until > blocked_from),
      CONSTRAINT appointments_blocked_contains_service
        CHECK (blocked_from <= start_at AND blocked_until >= service_end_at),
      CONSTRAINT appointments_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id)
    );

    -- Idempotency: one active appointment per (tenant, idempotency_key).
    CREATE UNIQUE INDEX appointments_idempotency_key_uniq
      ON appointments (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    -- THE anti double-book guarantee (Postgres-enforced, not app-only).
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_no_overlap
      EXCLUDE USING gist (
        staff_id WITH =,
        tstzrange(blocked_from, blocked_until, '[)') WITH &&
      )
      WHERE (status IN ('scheduled', 'confirmed'));

    CREATE INDEX appointments_tenant_client_start_idx ON appointments (tenant_id, client_id, start_at);
    CREATE INDEX appointments_tenant_site_start_idx ON appointments (tenant_id, site_id, start_at);
    CREATE INDEX appointments_tenant_staff_start_idx ON appointments (tenant_id, staff_id, start_at);
    CREATE INDEX appointments_tenant_status_idx ON appointments (tenant_id, status);
    CREATE INDEX appointments_tenant_start_idx ON appointments (tenant_id, start_at);
    CREATE INDEX appointments_contact_idx ON appointments (contact_id);
    CREATE INDEX appointments_source_conversation_idx ON appointments (source_conversation_id);

    -- ── appointment_events (audit trail; enough JSON detail to reconstruct) ─────
    CREATE TABLE appointment_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      appointment_id uuid NOT NULL REFERENCES appointments (id) ON DELETE CASCADE,
      event_type text NOT NULL CHECK (event_type IN (
        'appointment_created', 'appointment_rescheduled', 'appointment_cancelled',
        'appointment_confirmed', 'appointment_completed', 'appointment_no_show',
        'manual_note', 'mode_changed', 'escalation'
      )),
      actor_type text NOT NULL CHECK (actor_type IN ('system', 'agent', 'public', 'n8n')),
      actor_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX appointment_events_idx
      ON appointment_events (tenant_id, appointment_id, created_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Leave btree_gist installed (a shared extension); drop only our objects.
  pgm.sql(`
    DROP TABLE IF EXISTS appointment_events;
    DROP TABLE IF EXISTS appointments;
  `);
}
