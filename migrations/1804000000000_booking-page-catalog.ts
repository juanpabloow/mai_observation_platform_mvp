import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * BOOKING PAGE CATALOG — how a business PRESENTS its catalogue on the public booking page
 * (/book/{slug}), kept apart from what the catalogue IS (name, duration, price, active),
 * which stays the single source of truth for the agenda, the bot and the page.
 *
 *  booking_categories — the business's own customer-facing groups, per client
 *    ("Entre Nubes", "Signature", "Esencial"…), with a short tagline, an order, a
 *    visibility switch and a LAYOUT:
 *      list      cards (the default);
 *      featured  one large card per service (image, what it includes). A service is
 *                shown there ONLY when its presentation is complete — never half-filled;
 *      contact   the services are not listed; the page shows the tagline as a small link
 *                to the business's WhatsApp ("¿Buscas color?").
 *
 *  services.public_* — presentation of ONE service on the page:
 *    public_category_id         its group (NULL = ungrouped / legacy family grouping);
 *    public_visible             shown on the PAGE. Independent of `active` and of the
 *                               site enablement: hiding a service publicly never
 *                               disables it for the agenda or the bot;
 *    public_sort                order inside its group;
 *    public_recommended         the "Recomendado" badge (NOT `featured`, which the bot
 *                               API already uses to rank and filter);
 *    public_image_url           https only (the platform's bucket);
 *    public_includes            "Qué incluye", ≤ 8 short lines;
 *    public_upgrade_service_id  its explicit better alternative ("Pásate a …"). The
 *                               difference is always COMPUTED from the real prices.
 *
 *  sites.public_whatsapp / public_maps_url — the business's public contact. WhatsApp in
 *    E.164; Maps https only (the app further restricts it to Google Maps hosts).
 *
 * Same-client integrity: categories and upgrade targets are written only through the
 * repository, which checks STRUCTURALLY (in SQL) that they belong to the service's own
 * (tenant, client); the public read joins them with the same client, so a forged
 * reference fails closed. Services and categories are never hard-deleted by the app.
 *
 * Additive: every new column is nullable or has a default, so existing rows and INSERTs
 * are unchanged, and the page looks exactly as before until a business configures it.
 *
 * DOWN refuses while any presentation is configured (it would silently delete it).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE booking_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
      client_id uuid NOT NULL,
      name text NOT NULL CHECK (char_length(name) <= 40 AND btrim(name) <> ''),
      tagline text CHECK (tagline IS NULL OR (char_length(tagline) <= 80 AND btrim(tagline) <> '')),
      layout text NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'featured', 'contact')),
      sort_order integer NOT NULL DEFAULT 0,
      visible boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT booking_categories_client_fkey FOREIGN KEY (client_id, tenant_id)
        REFERENCES clients (id, tenant_id)
    );
    CREATE UNIQUE INDEX booking_categories_name_uniq ON booking_categories (tenant_id, client_id, lower(name));
    CREATE INDEX booking_categories_client_idx ON booking_categories (tenant_id, client_id, sort_order);

    ALTER TABLE services
      ADD COLUMN public_category_id uuid REFERENCES booking_categories (id) ON DELETE SET NULL,
      ADD COLUMN public_visible boolean NOT NULL DEFAULT true,
      ADD COLUMN public_sort integer NOT NULL DEFAULT 0,
      ADD COLUMN public_recommended boolean NOT NULL DEFAULT false,
      ADD COLUMN public_image_url text,
      ADD COLUMN public_includes text[],
      ADD COLUMN public_upgrade_service_id uuid REFERENCES services (id) ON DELETE SET NULL;
    ALTER TABLE services
      ADD CONSTRAINT services_public_image_url_check
        CHECK (public_image_url IS NULL OR (char_length(public_image_url) <= 1024 AND public_image_url ~ '^https://[^[:space:]]+$')),
      ADD CONSTRAINT services_public_includes_check
        CHECK (public_includes IS NULL OR (cardinality(public_includes) BETWEEN 1 AND 8)),
      ADD CONSTRAINT services_public_upgrade_not_self
        CHECK (public_upgrade_service_id IS NULL OR public_upgrade_service_id <> id);
    CREATE INDEX services_public_category_idx ON services (public_category_id) WHERE public_category_id IS NOT NULL;

    ALTER TABLE sites
      ADD COLUMN public_whatsapp text,
      ADD COLUMN public_maps_url text;
    ALTER TABLE sites
      ADD CONSTRAINT sites_public_whatsapp_check
        CHECK (public_whatsapp IS NULL OR public_whatsapp ~ '^\\+[1-9][0-9]{7,14}$'),
      ADD CONSTRAINT sites_public_maps_url_check
        CHECK (public_maps_url IS NULL OR (char_length(public_maps_url) <= 1024 AND public_maps_url ~ '^https://[^[:space:]]+$'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    LOCK TABLE services, sites, booking_categories IN ACCESS EXCLUSIVE MODE;
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM booking_categories)
         OR EXISTS (SELECT 1 FROM services
                     WHERE public_category_id IS NOT NULL OR public_visible = false OR public_sort <> 0
                        OR public_recommended OR public_image_url IS NOT NULL
                        OR public_includes IS NOT NULL OR public_upgrade_service_id IS NOT NULL)
         OR EXISTS (SELECT 1 FROM sites WHERE public_whatsapp IS NOT NULL OR public_maps_url IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = '23514',
          MESSAGE = 'Cannot drop the booking page catalog while it is configured. Review and clear it explicitly; nothing was deleted.';
      END IF;
    END $$;
    ALTER TABLE sites
      DROP CONSTRAINT sites_public_maps_url_check,
      DROP CONSTRAINT sites_public_whatsapp_check,
      DROP COLUMN public_maps_url,
      DROP COLUMN public_whatsapp;
    DROP INDEX services_public_category_idx;
    ALTER TABLE services
      DROP CONSTRAINT services_public_upgrade_not_self,
      DROP CONSTRAINT services_public_includes_check,
      DROP CONSTRAINT services_public_image_url_check,
      DROP COLUMN public_upgrade_service_id,
      DROP COLUMN public_includes,
      DROP COLUMN public_image_url,
      DROP COLUMN public_recommended,
      DROP COLUMN public_sort,
      DROP COLUMN public_visible,
      DROP COLUMN public_category_id;
    DROP TABLE booking_categories;
  `);
}
