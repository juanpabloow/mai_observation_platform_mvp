import { query } from '../../client.js';

/**
 * APPOINTMENT REVIEWS (migration 1801). Tenant-scoped like every scheduling repository;
 * the public reads only ever return APPROVED rows and only the fields a visitor may see.
 *
 *   requested → pending (customer submitted) → approved | hidden (business decided)
 */

export type ReviewStatus = 'requested' | 'pending' | 'approved' | 'hidden';

/** How long a review link stays usable after it is first requested. */
export const REVIEW_LINK_DAYS = 30;

export interface ReviewRequestRow {
  id: string;
  status: ReviewStatus;
  expires_at: Date;
}

/**
 * The review request of a COMPLETED appointment — created once, reused after. An expired
 * request that was never answered is renewed (new 30 days); an answered one is returned
 * as is. NULL when the appointment is not completed, not this client's, or unknown.
 */
export async function ensureReviewRequest(tenantId: string, clientId: string, appointmentId: string): Promise<ReviewRequestRow | null> {
  const r = await query<ReviewRequestRow>(
    `WITH appt AS (
       SELECT a.id, a.tenant_id, a.client_id, a.site_id, a.staff_id, a.service_id, a.service_name_snapshot
         FROM appointments a
        WHERE a.id = $3 AND a.tenant_id = $1 AND a.client_id = $2 AND a.status = 'completed'
     )
     INSERT INTO appointment_reviews (tenant_id, client_id, site_id, appointment_id, staff_id, service_id, service_name, expires_at)
     SELECT tenant_id, client_id, site_id, id, staff_id, service_id, service_name_snapshot, now() + make_interval(days => ${REVIEW_LINK_DAYS})
       FROM appt
     ON CONFLICT (appointment_id) DO UPDATE
        SET expires_at = CASE WHEN appointment_reviews.status = 'requested' AND appointment_reviews.expires_at < now()
                              THEN now() + make_interval(days => ${REVIEW_LINK_DAYS})
                              ELSE appointment_reviews.expires_at END,
            updated_at = now()
     RETURNING id, status, expires_at`,
    [tenantId, clientId, appointmentId],
  );
  return r.rows[0] ?? null;
}

/** Everything the public review page needs, resolved from the review id in the link. */
export interface ReviewForLink {
  id: string;
  tenant_id: string;
  status: ReviewStatus;
  expires_at: Date;
  appointment_status: string;
  site_name: string;
  site_address: string | null;
  timezone: string;
  service_name: string;
  staff_name: string | null;
  start_at: Date;
  contact_name: string | null;
  logo_url: string | null;
}

/**
 * Only through the same public gate as booking: active site, non-default client,
 * scheduling module enabled. Anything else reads as "no such link".
 */
export async function getReviewForLink(reviewId: string): Promise<ReviewForLink | null> {
  const r = await query<ReviewForLink>(
    `SELECT rv.id, rv.tenant_id, rv.status, rv.expires_at,
            a.status AS appointment_status,
            si.name AS site_name, si.address AS site_address, si.timezone,
            rv.service_name, st.name AS staff_name, a.start_at,
            co.name AS contact_name, c.logo_url
       FROM appointment_reviews rv
       JOIN appointments a ON a.id = rv.appointment_id AND a.tenant_id = rv.tenant_id AND a.client_id = rv.client_id
       JOIN sites si ON si.id = rv.site_id AND si.tenant_id = rv.tenant_id AND si.client_id = rv.client_id AND si.active = true
       JOIN clients c ON c.id = rv.client_id AND c.tenant_id = rv.tenant_id AND c.is_default = false
       JOIN client_modules cm ON cm.tenant_id = rv.tenant_id AND cm.client_id = rv.client_id
                             AND cm.module_key = 'scheduling' AND cm.enabled = true
       LEFT JOIN staff st ON st.id = rv.staff_id AND st.tenant_id = rv.tenant_id
       LEFT JOIN contacts co ON co.id = a.contact_id AND co.tenant_id = rv.tenant_id AND co.client_id = rv.client_id
      WHERE rv.id = $1`,
    [reviewId],
  );
  return r.rows[0] ?? null;
}

/**
 * The customer's answer — ONCE. Atomic: only a `requested`, unexpired row of a still
 * completed appointment moves to `pending`; a second submit (double click, replayed
 * link) changes nothing and returns null.
 */
export async function submitReview(input: {
  reviewId: string;
  rating: number;
  comment: string | null;
  authorDisplay: string;
}): Promise<{ id: string } | null> {
  const r = await query<{ id: string }>(
    `UPDATE appointment_reviews rv
        SET status = 'pending', rating = $2, comment = $3, author_display = $4, publish_consent = true,
            submitted_at = now(), updated_at = now()
       FROM appointments a
      WHERE rv.id = $1 AND rv.status = 'requested' AND rv.expires_at > now()
        AND a.id = rv.appointment_id AND a.tenant_id = rv.tenant_id AND a.status = 'completed'
     RETURNING rv.id`,
    [input.reviewId, input.rating, input.comment, input.authorDisplay],
  );
  return r.rows[0] ?? null;
}

export interface ReviewModerationRow {
  id: string;
  status: ReviewStatus;
  rating: number;
  comment: string | null;
  author_display: string;
  service_name: string;
  staff_name: string | null;
  site_name: string;
  timezone: string;
  start_at: Date;
  submitted_at: Date;
  moderated_at: Date | null;
}

/** The client's submitted reviews (never `requested`), newest first. */
export async function listReviewsForModeration(tenantId: string, clientId: string, status?: ReviewStatus): Promise<ReviewModerationRow[]> {
  const r = await query<ReviewModerationRow>(
    `SELECT rv.id, rv.status, rv.rating, rv.comment, rv.author_display, rv.service_name,
            st.name AS staff_name, si.name AS site_name, si.timezone, a.start_at, rv.submitted_at, rv.moderated_at
       FROM appointment_reviews rv
       JOIN appointments a ON a.id = rv.appointment_id AND a.tenant_id = rv.tenant_id
       JOIN sites si ON si.id = rv.site_id AND si.tenant_id = rv.tenant_id
       LEFT JOIN staff st ON st.id = rv.staff_id AND st.tenant_id = rv.tenant_id
      WHERE rv.tenant_id = $1 AND rv.client_id = $2 AND rv.status <> 'requested'
        AND ($3::text IS NULL OR rv.status = $3)
      ORDER BY rv.submitted_at DESC
      LIMIT 200`,
    [tenantId, clientId, status ?? null],
  );
  return r.rows;
}

/** Approve or hide a SUBMITTED review of this client. Returns false for anything else. */
export async function moderateReview(tenantId: string, clientId: string, reviewId: string, status: 'approved' | 'hidden', userId: string | null): Promise<boolean> {
  const r = await query(
    `UPDATE appointment_reviews
        SET status = $4, moderated_at = now(), moderated_by = $5, updated_at = now()
      WHERE id = $3 AND tenant_id = $1 AND client_id = $2 AND status IN ('pending', 'approved', 'hidden')`,
    [tenantId, clientId, reviewId, status, userId],
  );
  return (r.rowCount ?? 0) > 0;
}

// ── Public (booking page) ───────────────────────────────────────────────────────

export interface RatingSummary {
  average: number;
  count: number;
}

/** Approved-review average and count per professional of the site. */
export async function publicStaffRatings(tenantId: string, siteId: string): Promise<Map<string, RatingSummary>> {
  const r = await query<{ staff_id: string; average: string; count: number }>(
    `SELECT staff_id, round(avg(rating)::numeric, 1)::text AS average, count(*)::int AS count
       FROM appointment_reviews
      WHERE tenant_id = $1 AND site_id = $2 AND status = 'approved' AND staff_id IS NOT NULL
      GROUP BY staff_id`,
    [tenantId, siteId],
  );
  return new Map(r.rows.map((x) => [x.staff_id, { average: Number(x.average), count: x.count }]));
}

/** Approved-review average and count per service of the site (any professional). */
export async function publicServiceRatings(tenantId: string, siteId: string): Promise<Map<string, RatingSummary>> {
  const r = await query<{ service_id: string; average: string; count: number }>(
    `SELECT service_id, round(avg(rating)::numeric, 1)::text AS average, count(*)::int AS count
       FROM appointment_reviews
      WHERE tenant_id = $1 AND site_id = $2 AND status = 'approved' AND service_id IS NOT NULL
      GROUP BY service_id`,
    [tenantId, siteId],
  );
  return new Map(r.rows.map((x) => [x.service_id, { average: Number(x.average), count: x.count }]));
}

export interface PublicReviewRow {
  staff_id: string;
  author_display: string;
  service_name: string;
  rating: number;
  comment: string | null;
  submitted_at: Date;
}

/** The latest approved reviews (≤ `limit` each) of the given professionals at the site. */
export async function publicStaffReviews(tenantId: string, siteId: string, staffIds: string[], limit = 10): Promise<PublicReviewRow[]> {
  if (staffIds.length === 0) return [];
  const r = await query<PublicReviewRow>(
    `SELECT staff_id, author_display, service_name, rating, comment, submitted_at
       FROM (
         SELECT rv.*, row_number() OVER (PARTITION BY rv.staff_id ORDER BY rv.submitted_at DESC) AS n
           FROM appointment_reviews rv
          WHERE rv.tenant_id = $1 AND rv.site_id = $2 AND rv.status = 'approved' AND rv.staff_id = ANY($3::uuid[])
       ) x
      WHERE n <= $4
      ORDER BY staff_id, submitted_at DESC`,
    [tenantId, siteId, staffIds, limit],
  );
  return r.rows;
}
