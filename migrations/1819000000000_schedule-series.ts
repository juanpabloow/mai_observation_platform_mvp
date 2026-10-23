import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * RECURRING SCHEDULE — usual breaks and recurring blocks, with per-date exceptions, plus the
 * guest details of a walk-in that is NOT linked to a contact.
 *
 *  schedule_series            — ONE recurring rule. `kind`:
 *                                 break  a USUAL BREAK (lunch). The single source of truth of
 *                                        that break: changing one date is an override of THIS
 *                                        row, never a second, duplicated block. One weekday per
 *                                        row, so "this and the following" moves only that
 *                                        weekday.
 *                                 block  a recurring block/absence ("every Tuesday 16–17").
 *                               Owner: the site (staff_id NULL — applies to every professional
 *                               of the site, like the site's opening hours) or one professional.
 *                               Local wall-clock minutes in the SITE timezone (`start_min` <
 *                               `end_min`, 1440 = midnight). `starts_on` NULL = open start: a
 *                               break that already existed as a gap in the weekly hours keeps
 *                               its past exactly when it is turned into a row. `ends_on` NULL =
 *                               no end. An edit "from a date" never rewrites a row's past: it
 *                               ENDS the row the day before and creates the continuation
 *                               (`split_from_id`), so history stays as it was.
 *  schedule_series_overrides  — one occurrence of a series on one local date: `skip` (excluded
 *                               date) or `move` (that date only, other times). UNIQUE per date.
 *  appointments.guest_*       — name / phone / email typed for a walk-in that the operator chose
 *                               NOT to save as a contact. Shown again when the appointment is
 *                               reopened; never used to identify or merge contacts.
 *
 * Every row is tenant + client + site scoped with composite FKs (the professional must belong
 * to the same site and tenant). Additive: nothing existing is rewritten, no backfill. DOWN
 * refuses while rows/guest details exist (data a person entered is not dropped silently).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE schedule_series (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      site_id uuid NOT NULL,
      staff_id uuid,
      kind text NOT NULL CHECK (kind IN ('break', 'block')),
      weekdays smallint[] NOT NULL,
      start_min smallint NOT NULL,
      end_min smallint NOT NULL,
      starts_on date,
      ends_on date,
      reason text,
      public_reason text,
      split_from_id uuid REFERENCES schedule_series (id) ON DELETE SET NULL,
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT schedule_series_id_tenant_key UNIQUE (id, tenant_id),
      CONSTRAINT schedule_series_site_fk FOREIGN KEY (site_id, tenant_id, client_id)
        REFERENCES sites (id, tenant_id, client_id) ON DELETE CASCADE,
      CONSTRAINT schedule_series_staff_fk FOREIGN KEY (staff_id, tenant_id, site_id)
        REFERENCES staff (id, tenant_id, site_id) ON DELETE CASCADE,
      CONSTRAINT schedule_series_weekdays_check CHECK (
        cardinality(weekdays) BETWEEN 1 AND 7
        AND weekdays <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::smallint[]
      ),
      CONSTRAINT schedule_series_break_one_day CHECK (kind = 'block' OR cardinality(weekdays) = 1),
      CONSTRAINT schedule_series_minutes_check CHECK (
        start_min >= 0 AND end_min <= 1440 AND end_min > start_min
      ),
      CONSTRAINT schedule_series_dates_check CHECK (
        starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on
      ),
      CONSTRAINT schedule_series_reason_len CHECK (reason IS NULL OR char_length(reason) <= 500),
      CONSTRAINT schedule_series_public_reason_check CHECK (
        public_reason IS NULL
        OR (kind = 'block' AND (
          (public_reason = 'vacation' AND staff_id IS NOT NULL)
          OR (public_reason = 'site_closed' AND staff_id IS NULL)
          OR public_reason = 'unavailable'
        ))
      )
    );
    CREATE INDEX schedule_series_site_idx ON schedule_series (tenant_id, site_id, kind);
    CREATE INDEX schedule_series_staff_idx ON schedule_series (staff_id) WHERE staff_id IS NOT NULL;

    CREATE TABLE schedule_series_overrides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      series_id uuid NOT NULL,
      occurrence_date date NOT NULL,
      action text NOT NULL CHECK (action IN ('skip', 'move')),
      start_min smallint,
      end_min smallint,
      created_by_user_id text REFERENCES "user" (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT schedule_series_overrides_series_fk FOREIGN KEY (series_id, tenant_id)
        REFERENCES schedule_series (id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT schedule_series_overrides_one_per_date UNIQUE (series_id, occurrence_date),
      CONSTRAINT schedule_series_overrides_shape CHECK (
        (action = 'skip' AND start_min IS NULL AND end_min IS NULL)
        OR (action = 'move' AND start_min IS NOT NULL AND end_min IS NOT NULL
            AND start_min >= 0 AND end_min <= 1440 AND end_min > start_min)
      )
    );

    ALTER TABLE appointments
      ADD COLUMN guest_name text,
      ADD COLUMN guest_phone text,
      ADD COLUMN guest_email text,
      ADD CONSTRAINT appointments_guest_name_len CHECK (guest_name IS NULL OR char_length(guest_name) <= 120),
      ADD CONSTRAINT appointments_guest_phone_e164 CHECK (guest_phone IS NULL OR guest_phone ~ '^\\+[1-9][0-9]{6,14}$'),
      ADD CONSTRAINT appointments_guest_email_len CHECK (guest_email IS NULL OR char_length(guest_email) <= 254);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM schedule_series)
         OR EXISTS (SELECT 1 FROM appointments
                     WHERE guest_name IS NOT NULL OR guest_phone IS NOT NULL OR guest_email IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot drop schedule_series / appointments.guest_* while they hold data. Remove it explicitly first; nothing was changed.';
      END IF;
    END $$;
    ALTER TABLE appointments
      DROP CONSTRAINT appointments_guest_email_len,
      DROP CONSTRAINT appointments_guest_phone_e164,
      DROP CONSTRAINT appointments_guest_name_len,
      DROP COLUMN guest_email,
      DROP COLUMN guest_phone,
      DROP COLUMN guest_name;
    DROP TABLE schedule_series_overrides;
    DROP TABLE schedule_series;
  `);
}
