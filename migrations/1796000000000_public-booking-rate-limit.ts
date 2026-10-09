import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Persistent, shared rate limit for PUBLIC booking creation (POST /api/booking/{slug}).
 *
 * The in-memory limiter in web/lib/schedulingApi.ts is per-process and resets on every
 * deploy, so it only blunts bursts. Creating an appointment is the one public write, so
 * it also gets a limit that every web instance shares — in the SAME PostgreSQL, with no
 * extra Railway service.
 *
 * One row = one fixed window of one key at one site:
 *   scope     'ip' | 'phone' — what the key identifies;
 *   key_hash  HMAC-SHA256 hex of (scope, site, value). The IP or phone is NEVER stored
 *             in clear: the HMAC key is a server secret, so the column can't be reversed
 *             by enumerating the (small) IPv4 / phone-number space;
 *   hits      attempts counted in the window (incremented atomically by
 *             INSERT … ON CONFLICT DO UPDATE);
 *   expires_at  window end — rows past it are dead weight and are swept, scoped per site.
 *
 * Every row is scoped to (tenant, client, site) through the composite FK onto
 * sites (id, tenant_id, client_id) — the key added in 1784400000000 — so a bucket can never
 * name a site of another tenant/client, and ON DELETE CASCADE removes them with the site.
 *
 * Reversible: down() drops the table (it holds only ephemeral counters).
 *
 * NAMING: first written as 1784500000000_… on a branch cut before main gained
 * 1790000000000_client-roles and 1795000000000_setter-role. node-pg-migrate refuses a
 * pending migration dated BEFORE ones already run ("Not run migration … is preceding
 * already run migration …"), so it was renamed to sort after them. The content is
 * unchanged. test/unit/migrationOrder.test.ts guards the ordering.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE public_booking_rate_buckets (
      tenant_id    uuid        NOT NULL,
      client_id    uuid        NOT NULL,
      site_id      uuid        NOT NULL,
      scope        text        NOT NULL,
      key_hash     text        NOT NULL,
      window_start timestamptz NOT NULL,
      hits         integer     NOT NULL DEFAULT 1,
      expires_at   timestamptz NOT NULL,
      PRIMARY KEY (site_id, scope, key_hash, window_start),
      CONSTRAINT public_booking_rate_buckets_scope_check CHECK (scope IN ('ip', 'phone')),
      CONSTRAINT public_booking_rate_buckets_hash_check CHECK (key_hash ~ '^[0-9a-f]{64}$'),
      CONSTRAINT public_booking_rate_buckets_hits_check CHECK (hits >= 1),
      CONSTRAINT public_booking_rate_buckets_window_check CHECK (expires_at > window_start),
      CONSTRAINT public_booking_rate_buckets_site_fkey
        FOREIGN KEY (site_id, tenant_id, client_id)
        REFERENCES sites (id, tenant_id, client_id) ON DELETE CASCADE
    );

    -- The scoped sweep: DELETE … WHERE site_id = $1 AND expires_at < now().
    CREATE INDEX public_booking_rate_buckets_expiry_idx
      ON public_booking_rate_buckets (site_id, expires_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS public_booking_rate_buckets;`);
}
