import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * PROMOTIONS — an administrable entity per CLIENT, linked to EXISTING services, that never
 * changes their base price. The minimal model the defined promotions need; not a rules
 * engine.
 *
 *  promotions
 *    status          draft → published ⇄ paused → archived. Only `published` is ever shown
 *                    or applied. Archiving is the end of life; there is no delete in the
 *                    app, and a promotion referenced by an appointment cannot be deleted at
 *                    all (appointments.promotion_id, NO ACTION: only a whole-tenant
 *                    cascade can remove both together).
 *    benefit_type    ONLY the types that are actually defined. Today: `two_for_one` (2×1).
 *                    Its parameters (which services, how the two people are booked, the
 *                    eligibility proof…) are pending business decisions, so the application
 *                    refuses to PUBLISH it until they exist — a draft can be prepared.
 *    Two separate windows, never mixed:
 *      A. bookable_from / bookable_until — WHEN the booking can be MADE (vigencia);
 *      B. appointment_weekdays (ISO 1=Mon … 7=Sun) / appointment_from / appointment_until
 *         / appointment_time_from / appointment_time_until — WHEN the APPOINTMENT must
 *         happen to get the benefit, in the SITE's timezone. "Citas lunes y martes" is B,
 *         so the promotion stays visible on a Wednesday.
 *    version         optimistic concurrency: an edit names the version it read; a stale
 *                    one is refused instead of silently overwriting someone else.
 *    site_id         NULL = every site of the client.
 *
 *  promotion_services / promotion_staff — what it covers (staff empty = whoever performs
 *    the service). Same-client is checked by the repository's writes.
 *
 *  promotion_events — who created, edited, published, paused, archived or duplicated it
 *    (the same append-only pattern as appointment_events).
 *
 *  appointments.promotion_id / promotion_snapshot — the promotion, conditions and price a
 *    booking was made with, frozen at booking time: editing, pausing or archiving the
 *    promotion never changes a past booking.
 *
 * Additive. DOWN refuses while any promotion exists.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE promotions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      site_id uuid REFERENCES sites (id),
      name text NOT NULL CHECK (char_length(name) <= 80 AND btrim(name) <> ''),
      description text CHECK (description IS NULL OR (char_length(description) <= 600 AND btrim(description) <> '')),
      conditions text CHECK (conditions IS NULL OR (char_length(conditions) <= 600 AND btrim(conditions) <> '')),
      image_url text CHECK (image_url IS NULL OR (char_length(image_url) <= 1024 AND image_url ~ '^https://[^[:space:]]+$')),
      sort_order integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'paused', 'archived')),
      benefit_type text NOT NULL CHECK (benefit_type IN ('two_for_one')),
      benefit_params jsonb NOT NULL DEFAULT '{}'::jsonb,
      bookable_from timestamptz,
      bookable_until timestamptz,
      appointment_weekdays smallint[] CHECK (appointment_weekdays IS NULL OR (
        cardinality(appointment_weekdays) BETWEEN 1 AND 7 AND appointment_weekdays <@ ARRAY[1,2,3,4,5,6,7]::smallint[])),
      appointment_from date,
      appointment_until date,
      appointment_time_from time,
      appointment_time_until time,
      version integer NOT NULL DEFAULT 1,
      created_by text REFERENCES "user" (id) ON DELETE SET NULL,
      updated_by text REFERENCES "user" (id) ON DELETE SET NULL,
      published_at timestamptz,
      published_by text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT promotions_client_fkey FOREIGN KEY (client_id, tenant_id) REFERENCES clients (id, tenant_id),
      CONSTRAINT promotions_bookable_range CHECK (bookable_from IS NULL OR bookable_until IS NULL OR bookable_until > bookable_from),
      CONSTRAINT promotions_appointment_range CHECK (appointment_from IS NULL OR appointment_until IS NULL OR appointment_until >= appointment_from),
      CONSTRAINT promotions_time_range CHECK (
        (appointment_time_from IS NULL AND appointment_time_until IS NULL)
        OR (appointment_time_from IS NOT NULL AND appointment_time_until IS NOT NULL AND appointment_time_until > appointment_time_from))
    );
    CREATE INDEX promotions_client_idx ON promotions (tenant_id, client_id, status, sort_order);

    CREATE TABLE promotion_services (
      promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services (id),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      PRIMARY KEY (promotion_id, service_id)
    );
    CREATE TABLE promotion_staff (
      promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
      staff_id uuid NOT NULL REFERENCES staff (id),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      PRIMARY KEY (promotion_id, staff_id)
    );

    CREATE TABLE promotion_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      promotion_id uuid NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
      event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'published', 'paused', 'resumed', 'archived', 'duplicated')),
      actor_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      version integer NOT NULL,
      detail jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX promotion_events_idx ON promotion_events (tenant_id, promotion_id, created_at);

    ALTER TABLE appointments
      ADD COLUMN promotion_id uuid REFERENCES promotions (id),
      ADD COLUMN promotion_snapshot jsonb;
    ALTER TABLE appointments
      ADD CONSTRAINT appointments_promotion_snapshot CHECK ((promotion_id IS NULL) = (promotion_snapshot IS NULL));
    CREATE INDEX appointments_promotion_idx ON appointments (promotion_id) WHERE promotion_id IS NOT NULL;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    LOCK TABLE promotions, appointments IN ACCESS EXCLUSIVE MODE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM promotions) OR EXISTS (SELECT 1 FROM appointments WHERE promotion_id IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot drop promotions while any exists. Review and archive/remove them explicitly; nothing was deleted.';
      END IF;
    END $$;
    DROP INDEX appointments_promotion_idx;
    ALTER TABLE appointments
      DROP CONSTRAINT appointments_promotion_snapshot,
      DROP COLUMN promotion_snapshot,
      DROP COLUMN promotion_id;
    DROP TABLE promotion_events;
    DROP TABLE promotion_staff;
    DROP TABLE promotion_services;
    DROP TABLE promotions;
  `);
}
