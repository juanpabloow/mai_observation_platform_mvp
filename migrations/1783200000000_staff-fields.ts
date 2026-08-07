import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * STAFF FIELDS + SERVICE CATEGORY. Additive and fully reversible: every new column is
 * NULLABLE with no default, so not one existing row changes and every existing
 * INSERT (which names its columns) keeps working untouched.
 *
 * WHY. `staff` carried only name/site/working_hours/active, so the Staff screen's
 * Details tab had nothing to render. These are the fields that tab needs, and no more.
 *
 * DERIVED, NOT STORED — deliberately absent:
 *  - SENIORITY is computed from start_date. Storing "3 years" guarantees it is wrong
 *    within a year.
 *  - CHAIR has no column. The roster's "NO CHAIR" state comes from takes_bookings.
 *
 * takes_bookings IS NEW HERE. The brief assumed it already existed; it did not (the
 * roster was deriving that state from `active`, which conflates "deactivated" with
 * "works here but is not agendable" — a front-desk hire is the second, not the first).
 * It is the one non-nullable addition: `NOT NULL DEFAULT true` is safe precisely
 * because every row that exists today IS agendable, so the default is a true
 * statement about existing data, not a guess.
 *
 * PII. phone, email and the two emergency_contact_* columns are employee personal
 * data. The schema cannot enforce who reads them, so the restriction lives one layer
 * up: the staff repository has NO `SELECT *` any more (see staff.ts) — the default
 * projection lists the operational columns explicitly and CANNOT pick these up, and a
 * separate admin-only read is the only path that projects them. See the notes there.
 *
 * services.category replaces guessing a service's colour family from keywords in its
 * NAME. It is CHECK-constrained to the four families that actually have a palette, so
 * a typo can't produce an unstyled card; the keyword matcher survives only as the
 * fallback for rows where the operator hasn't set one.
 */

/** The colour families with a real palette (globals.css `.u-appt-*`). Kept in sync
 *  with web/lib/agendaCategory.ts — a fifth family means a migration AND a palette. */
const SERVICE_CATEGORIES = ['color', 'grooming', 'cut', 'feature'] as const;

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ── staff: contact ────────────────────────────────────────────────────────
    -- Nullable and unvalidated on purpose: an employee phone is entered by a human
    -- in whatever format the shop uses, and a CHECK that rejects it is a bug report.
    ALTER TABLE staff
      ADD COLUMN phone text,
      ADD COLUMN email text,
      ADD COLUMN emergency_contact_name text,
      ADD COLUMN emergency_contact_phone text;

    -- ── staff: contract ───────────────────────────────────────────────────────
    -- title is FREE TEXT ("Colour specialist", "Front desk"): it is a label the shop
    -- writes, not a role the system enforces. Login permissions are tenant_members.role
    -- and are a different thing entirely — this column must never be read as authority.
    ALTER TABLE staff
      ADD COLUMN title text,
      ADD COLUMN employment_type text,
      ADD COLUMN weekly_hours integer,
      ADD COLUMN start_date date,
      -- Simple tags. NULL = never filled in (distinct from '{}' = "asked, none"), so
      -- readers COALESCE rather than the column carrying a default nobody chose.
      ADD COLUMN skills text[];

    -- employment_type is a small closed set, so it IS constrained (unlike title):
    -- the UI filters on it. NOT VALID is unnecessary — every existing row is NULL.
    ALTER TABLE staff
      ADD CONSTRAINT staff_employment_type_valid
        CHECK (employment_type IS NULL OR employment_type IN ('full_time', 'part_time', 'contractor')),
      ADD CONSTRAINT staff_weekly_hours_valid
        CHECK (weekly_hours IS NULL OR (weekly_hours > 0 AND weekly_hours <= 168));

    -- ── staff: agendable? ─────────────────────────────────────────────────────
    -- Separates "works here" from "has a chair". active = false still means gone.
    ALTER TABLE staff ADD COLUMN takes_bookings boolean NOT NULL DEFAULT true;

    -- Composite unique so children can carry a tenant-checked FK (the pattern this
    -- schema already uses for clients_id_tenant_id_key). It is the structural half of
    -- multi-tenant isolation: a certification cannot point at another tenant's staff
    -- even if the application layer is wrong.
    ALTER TABLE staff ADD CONSTRAINT staff_id_tenant_id_key UNIQUE (id, tenant_id);

    -- ── staff_certifications ──────────────────────────────────────────────────
    -- A separate table, not a text[] like skills: a certification has DATES, and one
    -- that expired last month is operationally different from one that did not.
    CREATE TABLE staff_certifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      staff_id uuid NOT NULL,
      name text NOT NULL,
      issuer text,
      issued_on date,
      expires_on date,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      -- Deleting a staff member takes their certifications with them.
      CONSTRAINT staff_certifications_staff_fkey FOREIGN KEY (staff_id, tenant_id)
        REFERENCES staff (id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT staff_certifications_dates_valid
        CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
    );
    CREATE INDEX staff_certifications_staff_idx ON staff_certifications (tenant_id, staff_id);

    -- ── services: colour family ───────────────────────────────────────────────
    -- No index: the per-(tenant, client) catalogue is a handful of rows, same reason
    -- the featured-services migration gave.
    ALTER TABLE services ADD COLUMN category text;
    ALTER TABLE services
      ADD CONSTRAINT services_category_valid
        CHECK (category IS NULL OR category IN (${SERVICE_CATEGORIES.map((c) => `'${c}'`).join(', ')}));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE services DROP CONSTRAINT services_category_valid;
    ALTER TABLE services DROP COLUMN category;

    DROP TABLE IF EXISTS staff_certifications;

    -- The unique goes only AFTER the table that depends on it.
    ALTER TABLE staff DROP CONSTRAINT staff_id_tenant_id_key;
    ALTER TABLE staff DROP CONSTRAINT staff_employment_type_valid;
    ALTER TABLE staff DROP CONSTRAINT staff_weekly_hours_valid;
    ALTER TABLE staff
      DROP COLUMN takes_bookings,
      DROP COLUMN skills,
      DROP COLUMN start_date,
      DROP COLUMN weekly_hours,
      DROP COLUMN employment_type,
      DROP COLUMN title,
      DROP COLUMN emergency_contact_phone,
      DROP COLUMN emergency_contact_name,
      DROP COLUMN email,
      DROP COLUMN phone;
  `);
}
