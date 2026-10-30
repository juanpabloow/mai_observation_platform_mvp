import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * JP-8 §1 — STAFF OCCUPANCY daily rollup.
 *
 * `staff_day_occupancy`: one row per (tenant, client, site, staff, local day) holding the day's
 * capacity and how much of it was sold. All minute columns are whole minutes; `day` is the LOCAL
 * calendar day in the site's timezone (never UTC). The numbers are DERIVED (from the scheduling
 * engine + appointments + recorded payments) and can always be rebuilt from source — this table is
 * a cache kept current by a fail-safe dirty-mark + worker, and fully rebuildable by the backfill.
 *   - available_min      capacity: working hours ∩ site hours − breaks − time off − site closures
 *                        (the SAME engine the bot/booking page use; never minus appointments).
 *   - booked_min         service minutes of booked appointments (scheduled/confirmed/completed/
 *                        no_show), clipped to the available shift. "Ocupación reservada" numerator.
 *   - attended_min       service minutes of COMPLETED appointments, clipped. "Ocupación atendida".
 *   - no_show_min        service minutes of NO_SHOW appointments, clipped (the reservada−atendida gap).
 *   - outside_hours_min  booked service minutes OUTSIDE the available shift ("fuera de horario") —
 *                        reported separately so it never inflates the percentage.
 *   - collected_amount   recorded-payment SERVICE line totals attributed to this staff on this day.
 *                        NEVER commission. Only meaningful to money-permitted viewers.
 * Cancelled appointments never contribute. Occupied time counts SERVICE duration only (no buffers).
 *
 * `occupancy_dirty_days`: the recompute queue. Every write that can change a (staff, local day) —
 * an appointment create/cancel/complete/no-show/reschedule/service-change/time-correction, a payment
 * record/void, or a change to weekly hours / breaks / time off / closures — marks the affected
 * (staff, day) here (fail-safe, post-commit). A worker drains it every few minutes; a nightly pass
 * re-enqueues a rolling window. `enqueued_at` is bumped on every re-mark so a mark that lands DURING
 * a recompute survives (the drainer deletes only rows whose enqueued_at it already saw).
 *
 * Reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE staff_day_occupancy (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
      day date NOT NULL,
      available_min integer NOT NULL DEFAULT 0 CHECK (available_min >= 0),
      booked_min integer NOT NULL DEFAULT 0 CHECK (booked_min >= 0),
      attended_min integer NOT NULL DEFAULT 0 CHECK (attended_min >= 0),
      no_show_min integer NOT NULL DEFAULT 0 CHECK (no_show_min >= 0),
      outside_hours_min integer NOT NULL DEFAULT 0 CHECK (outside_hours_min >= 0),
      collected_amount numeric(12, 2) NOT NULL DEFAULT 0 CHECK (collected_amount >= 0),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, client_id, site_id, staff_id, day),
      CONSTRAINT staff_day_occupancy_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE
    );
    -- Range reads for the screen: a client's whole team over a day/week/month window.
    CREATE INDEX staff_day_occupancy_client_day_idx ON staff_day_occupancy (tenant_id, client_id, day);
    -- Per-professional trend / free-hours lookups.
    CREATE INDEX staff_day_occupancy_staff_idx ON staff_day_occupancy (tenant_id, client_id, staff_id, day);

    CREATE TABLE occupancy_dirty_days (
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      site_id uuid NOT NULL,
      staff_id uuid NOT NULL,
      day date NOT NULL,
      enqueued_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, client_id, site_id, staff_id, day),
      CONSTRAINT occupancy_dirty_days_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id) ON DELETE CASCADE
    );
    -- Drain oldest-first.
    CREATE INDEX occupancy_dirty_days_enqueued_idx ON occupancy_dirty_days (enqueued_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE IF EXISTS occupancy_dirty_days;
    DROP TABLE IF EXISTS staff_day_occupancy;
  `);
}
