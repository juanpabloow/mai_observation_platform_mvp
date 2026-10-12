import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * CATALOG-2: the `products` table — a per-client catalogue of what a business
 * SELLS (waxes, oils, shampoos…), distinct from what it DOES (services). INFORM
 * ONLY in this phase: no orders, no reservations, no stock quantities, no payments.
 *
 * Scoped exactly like `services`: tenant_id + client_id, with the composite FK to
 * clients (id, tenant_id) that structurally forbids a cross-tenant client. Every
 * repository query carries BOTH predicates.
 *
 * Price REUSE: `numeric(10, 2)` — the SAME storage representation as services.price
 * (migration 1782000000001), so the one money helper (web/lib/money.ts:priceLabelCOP)
 * formats a product and a service identically. Unlike a service, a product price is
 * REQUIRED and must be > 0 (you can't offer to sell a thing with no price).
 *
 * description mirrors services.description (migration 1797): ≤500 chars, non-blank,
 * whitespace-only is forbidden at the DB (the server maps blanks → NULL first).
 *
 * in_stock  — the manual "disponible / agotado" switch (NOT a quantity). Default true.
 * is_active — archive instead of hard delete: a future sales/orders phase will
 *             reference products and deleting would orphan history. Inactive products
 *             never reach the bot. Default true.
 * sort_order — operator ordering; the machine API sorts by (sort_order, name).
 *
 * Uniqueness is PARTIAL — only among ACTIVE products of a client, case- AND
 * whitespace-folded. This is what "unique per client" means in practice: two live
 * products can't share a name, but archiving "Óleo" doesn't forever reserve the name
 * (you can add a new active "Óleo", or restore the old one). A name may of course
 * repeat across different clients.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE products (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      name text NOT NULL,
      description text,
      price numeric(10, 2) NOT NULL CHECK (price > 0),
      category text,
      in_stock boolean NOT NULL DEFAULT true,
      is_active boolean NOT NULL DEFAULT true,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT products_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id) ON DELETE CASCADE,
      CONSTRAINT products_name_not_blank CHECK (btrim(name) <> ''),
      CONSTRAINT products_description_len_check
        CHECK (description IS NULL OR (char_length(description) <= 500 AND btrim(description) <> '')),
      CONSTRAINT products_category_not_blank CHECK (category IS NULL OR btrim(category) <> '')
    );

    CREATE INDEX products_tenant_client_idx ON products (tenant_id, client_id);

    -- Case/whitespace-insensitive uniqueness of name, among ACTIVE products of a client.
    CREATE UNIQUE INDEX products_client_active_name_unique
      ON products (tenant_id, client_id, lower(btrim(name)))
      WHERE is_active;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS products;`);
}
