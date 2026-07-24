import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * SCHED-1: the scheduling resource model — sites, staff, services, the two
 * enablement join tables, and schedule exceptions. All tenant-scoped
 * (tenant_id → tenants, the canonical tenant). Appointments + the anti-double-book
 * constraint land in the next migration (SCHED-2).
 *
 * Design notes:
 * - sites.slug is GLOBALLY UNIQUE so the public booking page /book/{slug} resolves
 *   without leaking a tenant id into the URL. Times are stored as timestamptz/UTC
 *   everywhere; sites.timezone (IANA, e.g. America/Bogota) is how they are
 *   presented and how local opening/working hours are interpreted.
 * - opening_hours / working_hours: jsonb weekly map keyed by lowercase weekday
 *   ("mon".."sun"), each an array of {start,end} "HH:MM" LOCAL ranges. A missing
 *   weekday = closed that day. staff working_hours = {} means "inherit the site's
 *   opening hours" (the common V1 case: staff work whenever the shop is open).
 * - scheduling_config: jsonb, minimum keys slot_interval_min, min_notice_min,
 *   booking_horizon_days, default_buffer_before_min, default_buffer_after_min.
 * - Service ownership is EXPLICIT: services are tenant-level; site_services enables
 *   a service at a site and staff_services makes a staff member able to perform it
 *   (with optional per-site / per-staff duration & price overrides). No ambiguous
 *   "client_id and site_id both optional" ownership, and NO services-as-array.
 * - schedule_exceptions: a blocked interval. staff_id NULL = the whole site is
 *   blocked; otherwise just that staff member. ends_at > starts_at enforced.
 *
 * Fully reversible (dependents dropped first).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    -- ── sites ────────────────────────────────────────────────────────────────
    CREATE TABLE sites (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      -- A site belongs to a CLIENT (a business within the tenant). The composite
      -- FK forces the client to be in the SAME tenant (matches the RBAC model,
      -- where a member is scoped to exactly one client).
      client_id uuid NOT NULL,
      slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
      name text NOT NULL,
      address text,
      timezone text NOT NULL DEFAULT 'America/Bogota',
      opening_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
      scheduling_config jsonb NOT NULL DEFAULT
        '{"slot_interval_min":15,"min_notice_min":120,"booking_horizon_days":30,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sites_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id)
    );
    CREATE INDEX sites_tenant_idx ON sites (tenant_id);
    CREATE INDEX sites_tenant_client_idx ON sites (tenant_id, client_id);

    -- ── staff (an agendable RESOURCE; not necessarily an MT_AI user) ───────────
    CREATE TABLE staff (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      name text NOT NULL,
      working_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX staff_tenant_site_idx ON staff (tenant_id, site_id);

    -- ── services (tenant-level catalogue) ──────────────────────────────────────
    CREATE TABLE services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      duration_min integer NOT NULL CHECK (duration_min > 0),
      price numeric(10, 2) CHECK (price IS NULL OR price >= 0),
      buffer_before_min integer NOT NULL DEFAULT 0 CHECK (buffer_before_min >= 0),
      buffer_after_min integer NOT NULL DEFAULT 0 CHECK (buffer_after_min >= 0),
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX services_tenant_idx ON services (tenant_id);

    -- ── site_services (enable a service at a site) ─────────────────────────────
    CREATE TABLE site_services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      active boolean NOT NULL DEFAULT true,
      duration_override_min integer CHECK (duration_override_min IS NULL OR duration_override_min > 0),
      price_override numeric(10, 2) CHECK (price_override IS NULL OR price_override >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (site_id, service_id)
    );
    CREATE INDEX site_services_tenant_idx ON site_services (tenant_id);
    CREATE INDEX site_services_service_idx ON site_services (service_id);

    -- ── staff_services (a staff member can perform a service) ──────────────────
    CREATE TABLE staff_services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      staff_id uuid NOT NULL REFERENCES staff (id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services (id) ON DELETE CASCADE,
      active boolean NOT NULL DEFAULT true,
      duration_override_min integer CHECK (duration_override_min IS NULL OR duration_override_min > 0),
      price_override numeric(10, 2) CHECK (price_override IS NULL OR price_override >= 0),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (staff_id, service_id)
    );
    CREATE INDEX staff_services_tenant_idx ON staff_services (tenant_id);
    CREATE INDEX staff_services_service_idx ON staff_services (service_id);

    -- ── schedule_exceptions (blocked time) ─────────────────────────────────────
    CREATE TABLE schedule_exceptions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
      staff_id uuid REFERENCES staff (id) ON DELETE CASCADE,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      reason text,
      type text NOT NULL DEFAULT 'blocked' CHECK (type IN ('blocked')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT schedule_exceptions_range_valid CHECK (ends_at > starts_at)
    );
    CREATE INDEX schedule_exceptions_site_idx ON schedule_exceptions (tenant_id, site_id, starts_at);
    CREATE INDEX schedule_exceptions_staff_idx ON schedule_exceptions (staff_id, starts_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TABLE IF EXISTS schedule_exceptions;
    DROP TABLE IF EXISTS staff_services;
    DROP TABLE IF EXISTS site_services;
    DROP TABLE IF EXISTS services;
    DROP TABLE IF EXISTS staff;
    DROP TABLE IF EXISTS sites;
  `);
}
