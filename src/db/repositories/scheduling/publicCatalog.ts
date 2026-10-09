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
 */

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
}

export async function listPublicServicesForSite(tenantId: string, siteId: string): Promise<PublicServiceRow[]> {
  const r = await query<PublicServiceRow>(
    `SELECT sv.id, sv.name, sv.description,
            COALESCE(ss.duration_override_min, sv.duration_min) AS duration_min,
            COALESCE(ss.price_override, sv.price) AS price,
            sv.category
       FROM sites si
       JOIN site_services ss
         ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.active = true
       JOIN services sv
         ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id
        AND sv.client_id = si.client_id AND sv.active = true
      WHERE si.tenant_id = $1 AND si.id = $2 AND si.active = true
        -- A service nobody can perform is not offered: it would only ever show "Sin cupos".
        AND EXISTS (
              SELECT 1 FROM staff st
                JOIN staff_services sts
                  ON sts.staff_id = st.id AND sts.service_id = sv.id
                 AND sts.tenant_id = si.tenant_id AND sts.active = true
               WHERE st.site_id = si.id AND st.tenant_id = si.tenant_id AND st.active = true
            )
      ORDER BY sv.featured DESC, sv.name`,
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
            COALESCE(sts.price_override, ss.price_override, sv.price) AS price
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
