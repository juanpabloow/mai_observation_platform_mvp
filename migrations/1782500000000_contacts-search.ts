import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * C1-2: make contact search indexable + support keyset pagination.
 *
 * The list search was `ILIKE '%q%'` across 4 columns — never index-served (a
 * prefix-wildcard defeats a b-tree), so a seq scan per keystroke as contacts grow.
 * Fix with pg_trgm:
 *
 *  - `contacts_search_trgm_idx`: a GIN trigram index over a "search document"
 *    expression = name + email + channel_user_id + phone_e164 + a DIGITS-ONLY copy
 *    of the phone. This accelerates the single-input substring search AND lets a
 *    phone typed with spaces/+/dashes match the stored E.164 (the query strips
 *    non-digits and matches the digits-only token). GIN trigram serves both LIKE
 *    and ILIKE for needles of length >= 3 (shorter needles fall back to a scan —
 *    acceptable, they are rare and match broadly anyway).
 *    ⚠️ This index expression MUST stay byte-identical to CONTACT_SEARCH_DOC in
 *    src/db/repositories/contacts.ts (minus the `c.` alias), or the planner won't
 *    use it.
 *  - `contacts_client_recency_idx`: a b-tree on (tenant_id, client_id,
 *    last_contact_at DESC, id DESC) so the list's keyset pagination
 *    (ORDER BY last_contact_at DESC, id DESC + `(last_contact_at, id) < cursor`) is
 *    index-served rather than a full sort.
 *
 * pg_trgm is a TRUSTED extension (PG13+) — creatable by the DB owner without
 * superuser. Both indexes build non-concurrently inside the migration transaction;
 * safe because `contacts` is currently empty and stays small. No table/column shape
 * change (no new columns), so existing `SELECT *` callers are unaffected.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE EXTENSION IF NOT EXISTS pg_trgm;

    CREATE INDEX IF NOT EXISTS contacts_search_trgm_idx ON contacts USING gin (
      (
        lower(
          coalesce(name, '') || ' ' ||
          coalesce(email, '') || ' ' ||
          coalesce(channel_user_id, '') || ' ' ||
          coalesce(phone_e164, '') || ' ' ||
          regexp_replace(coalesce(phone_e164, ''), '[^0-9]', '', 'g')
        )
      ) gin_trgm_ops
    );

    CREATE INDEX IF NOT EXISTS contacts_client_recency_idx
      ON contacts (tenant_id, client_id, last_contact_at DESC, id DESC);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS contacts_client_recency_idx;
    DROP INDEX IF EXISTS contacts_search_trgm_idx;
    -- Intentionally leave the pg_trgm extension installed: other objects may come to
    -- rely on it, and dropping a shared extension is riskier than leaving it.
  `);
}
