import { query } from '../../client.js';

/**
 * The PUBLIC booking catalogue — what an anonymous visitor of /book/{slug} may see.
 *
 * The projection is the permission (same rule as staff.ts): these queries name every
 * column they return, and none of them is internal. A route that forgets to project
 * still cannot leak a tenant/client id, a buffer, a featured flag, an employee's phone
 * or an inactive barber, because the row never carried them.
 *
 * Every read walks the FULL active chain (site → site_service → service of the SAME
 * client → staff of that site → staff_service), all same-tenant, so an inconsistent or
 * foreign row fails closed (no row) instead of surfacing.
 *
 * Callers pass the (tenant, site) the public gate (getPublicBookingSiteBySlug)
 * resolved — never anything taken from the request.
 *
 * PAGE VISIBILITY (migration 1804) is a separate, presentation-only rule: a service is
 * offered on the PAGE when it is `public_visible` and its booking category (if any, of
 * the SAME client) is visible and lists services (not a `contact` group). It never
 * changes what the agenda or the bot may book — those keep reading services.ts.
 */

/**
 * The page-visibility predicate for a service `sv` at site `si`, as ONE SQL fragment so
 * the catalogue, the staff list, the availability guard and the booking guard can never
 * disagree. A category reference to another client is ignored (treated as ungrouped).
 */
export function publicServicePredicate(sv: string, si: string): string {
  return `${sv}.public_visible = true
        AND NOT EXISTS (
              SELECT 1 FROM booking_categories bcx
               WHERE bcx.id = ${sv}.public_category_id
                 AND bcx.tenant_id = ${si}.tenant_id AND bcx.client_id = ${si}.client_id
                 AND (bcx.visible = false OR bcx.layout = 'contact')
            )`;
}

export interface PublicServiceRow {
  id: string;
  name: string;
  description: string | null;
  /** Effective at this site: site override → service base. */
  duration_min: number;
  /** Effective at this site: site override → service base. NULL = no price published. */
  price: string | null;
  /** Operator-chosen colour family (CHECK-constrained); NULL = unclassified. */
  category: string | null;
  /** The booking-page group (same client, visible, a listing layout); NULL = ungrouped. */
  public_category_id: string | null;
  public_sort: number;
  public_recommended: boolean;
  public_image_url: string | null;
  public_includes: string[] | null;
  /** The explicit better alternative; only meaningful when it is itself in this list. */
  public_upgrade_service_id: string | null;
}

export async function listPublicServicesForSite(tenantId: string, siteId: string): Promise<PublicServiceRow[]> {
  const r = await query<PublicServiceRow>(
    `SELECT sv.id, sv.name, sv.description,
            COALESCE(ss.duration_override_min, sv.duration_min) AS duration_min,
            COALESCE(ss.price_override, sv.price) AS price,
            sv.category,
            bc.id AS public_category_id,
            sv.public_sort, sv.public_recommended, sv.public_image_url, sv.public_includes,
            sv.public_upgrade_service_id
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
       LEFT JOIN booking_categories bc
         ON bc.id = sv.public_category_id AND bc.tenant_id = si.tenant_id AND bc.client_id = si.client_id
      WHERE si.tenant_id = $1 AND si.id = $2 AND si.active = true
        AND ${publicServicePredicate('sv', 'si')}
        -- A service nobody can perform is not offered: it would only ever show "Sin cupos".
        AND EXISTS (
              SELECT 1 FROM staff st
                JOIN staff_services sts
                  ON sts.staff_id = st.id AND sts.service_id = sv.id
                 AND sts.tenant_id = si.tenant_id AND sts.active = true
               WHERE st.site_id = si.id AND st.tenant_id = si.tenant_id AND st.active = true
                 AND st.takes_bookings = true
            )
      ORDER BY sv.public_sort, sv.featured DESC, sv.name`,
    [tenantId, siteId],
  );
  return r.rows;
}

export interface PublicStaffRow {
  id: string;
  name: string;
  /** This professional's effective duration for the service (staff → site → base). */
  duration_min: number;
  /** This professional's effective price for the service (staff → site → base). */
  price: string | null;
  /** The PUBLIC profile only (migration 1800) — never `title`, never a contact field. */
  public_title: string | null;
  public_bio: string | null;
  public_photo_url: string | null;
  /** The public services (same rule as listPublicServicesForSite) this professional
   *  performs at the site — for "Servicios que realiza" on the profile. */
  service_ids: string[];
}

/**
 * Professionals at the site who can perform the service. Only ACTIVE staff who take
 * bookings (takes_bookings — a front-desk hire is active but holds no chair) — never
 * an inactive barber, never a contact field.
 */
export async function listPublicStaffForService(
  tenantId: string,
  siteId: string,
  serviceId: string,
): Promise<PublicStaffRow[]> {
  const r = await query<PublicStaffRow>(
    `SELECT st.id, st.name,
            COALESCE(sts.duration_override_min, ss.duration_override_min, sv.duration_min) AS duration_min,
            COALESCE(sts.price_override, ss.price_override, sv.price) AS price,
            st.public_title, st.public_bio, st.public_photo_url,
            ARRAY(
              SELECT sts2.service_id
                FROM staff_services sts2
                JOIN site_services ss2
                  ON ss2.service_id = sts2.service_id AND ss2.site_id = si.id
                 AND ss2.tenant_id = si.tenant_id AND ss2.active = true
                JOIN services sv2
                  ON sv2.id = sts2.service_id AND sv2.tenant_id = si.tenant_id
                 AND sv2.client_id = si.client_id AND sv2.active = true
               WHERE sts2.staff_id = st.id AND sts2.tenant_id = si.tenant_id AND sts2.active = true
                 AND ${publicServicePredicate('sv2', 'si')}
               ORDER BY sv2.public_sort, sv2.featured DESC, sv2.name
            ) AS service_ids
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.service_id = $3 AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
       JOIN staff st
         ON st.site_id = si.id AND st.tenant_id = si.tenant_id
        AND st.active = true AND st.takes_bookings = true
       JOIN staff_services sts
         ON sts.staff_id = st.id AND sts.service_id = sv.id AND sts.tenant_id = si.tenant_id AND sts.active = true
      WHERE si.tenant_id = $1 AND si.id = $2 AND si.active = true
        AND ${publicServicePredicate('sv', 'si')}
      ORDER BY st.name, st.id`,
    [tenantId, siteId, serviceId],
  );
  return r.rows;
}

/** The professional's display NAME for a confirmation — scoped to the site, nothing else. */
export async function getPublicStaffName(tenantId: string, siteId: string, staffId: string): Promise<string | null> {
  const r = await query<{ name: string }>(
    `SELECT name FROM staff WHERE id = $1 AND tenant_id = $2 AND site_id = $3`,
    [staffId, tenantId, siteId],
  );
  return r.rows[0]?.name ?? null;
}

/**
 * The business's uploaded logo (clients.logo_url — a public R2 object URL) for the
 * booking page header. ONLY the URL, and only when it is an absolute https URL; the
 * client's id, name or any other column never leave this function.
 */
export async function getPublicBrandLogo(tenantId: string, clientId: string): Promise<string | null> {
  const r = await query<{ logo_url: string | null }>(
    `SELECT logo_url FROM clients WHERE id = $1 AND tenant_id = $2 AND is_default = false`,
    [clientId, tenantId],
  );
  const url = r.rows[0]?.logo_url ?? null;
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Is `serviceId` offered on the PAGE of this site right now? The booking POST asks it
 * before the engine, so a service hidden from the page (or listed only as a WhatsApp
 * link) cannot be booked by calling the public API directly. Same predicate as the list.
 */
export async function isPublicServiceAtSite(tenantId: string, siteId: string, serviceId: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    `SELECT true AS ok
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.service_id = $3 AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
      WHERE si.tenant_id = $1 AND si.id = $2 AND si.active = true
        AND ${publicServicePredicate('sv', 'si')}`,
    [tenantId, siteId, serviceId],
  );
  return r.rows.length > 0;
}

export interface PublicCategoryRow {
  id: string;
  name: string;
  tagline: string | null;
  layout: 'list' | 'featured' | 'contact';
  sort_order: number;
}

/** The business's VISIBLE booking-page groups, in order (the page drops empty ones). */
export async function listPublicCategories(tenantId: string, clientId: string): Promise<PublicCategoryRow[]> {
  const r = await query<PublicCategoryRow>(
    `SELECT id, name, tagline, layout, sort_order
       FROM booking_categories
      WHERE tenant_id = $1 AND client_id = $2 AND visible = true
      ORDER BY sort_order, lower(name)`,
    [tenantId, clientId],
  );
  return r.rows;
}
