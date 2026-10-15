-- Gallery Experience — booking page catalog data plan (migrations 1804 + 1805 applied first).
--
-- DRY RUN BY DEFAULT: everything runs inside ONE transaction that ends in ROLLBACK, and
-- prints what exists before and what would exist after. Nothing is kept.
-- To apply, with explicit authorization only, replace the final ROLLBACK by COMMIT.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v slug=test -f docs/sql/gallery-booking-page-plan.sql
--
-- It never changes a service's name, duration, price, active flag or site enablement,
-- never touches appointments, and never deletes anything. Every UPDATE is scoped to the
-- client that owns the site with this slug. Values marked PENDING must be confirmed by
-- the business first (docs/booking-page-and-promotions.md §7).

\set ON_ERROR_STOP on
BEGIN;

CREATE TEMP TABLE plan_site ON COMMIT DROP AS
  SELECT id AS site_id, tenant_id, client_id, name, address, opening_hours, public_whatsapp
    FROM sites WHERE slug = :'slug' AND active = true;
DO $$ BEGIN
  IF (SELECT count(*) FROM plan_site) <> 1 THEN RAISE EXCEPTION 'expected exactly one active site for this slug'; END IF;
END $$;

\echo '== Site as it is (verify address and hours against the business) =='
SELECT name, address, opening_hours, public_whatsapp FROM plan_site;

\echo '== Catalogue vs the requirements (PDF). Any mismatch = STOP and ask; prices are NOT changed here =='
WITH want(name, duration_min, price) AS (VALUES
  ('Corte', 50, 60000), ('Barba', 45, 60000), ('Corte con barba', 60, 100000),
  ('Corte Signature', 70, 100000), ('Barba Ritual Signature', 60, 100000),
  ('Corte con barba ritual de toallas', 70, 115000), ('Corte con barba Signature', 85, 150000),
  ('Ritual Signature', NULL, 70000))
SELECT w.name, w.duration_min AS want_min, s.duration_min AS have_min, w.price AS want_price, s.price AS have_price,
       CASE WHEN s.id IS NULL THEN 'MISSING'
            WHEN (w.duration_min IS NOT NULL AND w.duration_min <> s.duration_min) OR w.price <> s.price THEN 'DIFFERENT'
            ELSE 'ok' END AS check,
       s.description IS NULL AS no_description
  FROM want w
  LEFT JOIN services s ON s.name = w.name AND s.client_id = (SELECT client_id FROM plan_site) AND s.active
 ORDER BY w.name;

\echo '== Services WITHOUT description (fill only with approved text) =='
SELECT s.name FROM services s WHERE s.client_id = (SELECT client_id FROM plan_site) AND s.active AND s.description IS NULL ORDER BY s.name;

-- 1. The business's groups, in order.
INSERT INTO booking_categories (tenant_id, client_id, name, tagline, layout, sort_order)
SELECT p.tenant_id, p.client_id, v.name, v.tagline, v.layout, v.ord
  FROM plan_site p,
       (VALUES ('Entre Nubes', 'Una experiencia inolvidable', 'featured', 0),
               ('Signature',   'El ritual completo',          'list',     1),
               ('Esencial',    'Impecable y a tiempo',        'list',     2),
               ('Color',       '¿Buscas color?',              'contact',  3)) AS v(name, tagline, layout, ord)
ON CONFLICT DO NOTHING;

-- 2. Assign services by EXACT name (unmatched names simply stay ungrouped).
UPDATE services s
   SET public_category_id = c.id, public_sort = v.ord, updated_at = now()
  FROM plan_site p
  JOIN booking_categories c ON c.client_id = p.client_id AND c.tenant_id = p.tenant_id,
       (VALUES ('Corte', 'Esencial', 0), ('Barba', 'Esencial', 1), ('Corte con barba', 'Esencial', 2),
               ('Corte Signature', 'Signature', 0), ('Barba Ritual Signature', 'Signature', 1),
               ('Corte con barba ritual de toallas', 'Signature', 2), ('Corte con barba Signature', 'Signature', 3)) AS v(svc, cat, ord)
 WHERE c.name = v.cat AND s.client_id = p.client_id AND s.tenant_id = p.tenant_id AND s.name = v.svc;

-- Colour services: every service of the agenda's "color" family goes to the WhatsApp group
-- (they stay bookable by the agenda and the bot).
UPDATE services s SET public_category_id = c.id, updated_at = now()
  FROM plan_site p JOIN booking_categories c ON c.client_id = p.client_id AND c.name = 'Color'
 WHERE s.client_id = p.client_id AND s.category = 'color';

-- 3. "Recomendado".
UPDATE services s SET public_recommended = true, updated_at = now()
  FROM plan_site p WHERE s.client_id = p.client_id AND s.name = 'Corte con barba Signature';

-- 4. Ritual Signature is no longer offered on its own ON THE PAGE (the record, its
--    appointments, the agenda and the bot are untouched).
UPDATE services s SET public_visible = false, updated_at = now()
  FROM plan_site p WHERE s.client_id = p.client_id AND s.name = 'Ritual Signature';

-- 5. PENDING confirmation: the upgrade pairs (the page computes the real difference).
UPDATE services s SET public_upgrade_service_id = t.id, updated_at = now()
  FROM plan_site p
  JOIN services t ON t.client_id = p.client_id AND t.active,
       (VALUES ('Corte', 'Corte Signature'), ('Barba', 'Barba Ritual Signature'), ('Corte con barba', 'Corte con barba Signature')) AS v(f, t)
 WHERE s.client_id = p.client_id AND s.name = v.f AND t.name = v.t;

-- 6. PENDING confirmation: the business WhatsApp (from the PDF).
UPDATE sites SET public_whatsapp = '+573022275653', updated_at = now() WHERE id = (SELECT site_id FROM plan_site);

\echo '== What the page would show =='
SELECT c.sort_order, c.name AS grupo, c.layout, s.name AS servicio, s.public_visible AS visible, s.public_recommended AS recomendado,
       u.name AS alternativa, (u.price - s.price)::int AS diferencia
  FROM services s
  LEFT JOIN booking_categories c ON c.id = s.public_category_id
  LEFT JOIN services u ON u.id = s.public_upgrade_service_id
 WHERE s.client_id = (SELECT client_id FROM plan_site) AND s.active
 ORDER BY c.sort_order NULLS LAST, s.public_sort, s.name;

-- DRY RUN: nothing above is kept. Replace by COMMIT only with explicit authorization.
ROLLBACK;
