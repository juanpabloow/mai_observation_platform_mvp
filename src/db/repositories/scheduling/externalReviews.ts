import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../client.js';

/**
 * EXTERNAL (Fresha) REVIEWS — import, provenance and publication (migration 1807).
 *
 * Every PLATFORM function here is called only after requirePlatformAdmin() on the server
 * (web/lib/platformReviewActions.ts). They still never trust a bare id: each one names the
 * SITE it acts on and only touches rows of that site's (tenant, client), and only rows
 * whose source is not 'mai' — a review collected here keeps its own moderation.
 *
 * The BUSINESS functions (list / request) are scoped by (tenant, client) like every other
 * repository and can never change a rating, comment, author, date, origin or status.
 *
 * Every administrative write appends a review_events row in the same transaction. Nothing
 * here stores the uploaded file, a phone, an e-mail or a credential.
 */

export interface ExternalReviewInsert {
  externalKey: string;
  staffId: string | null;
  serviceId: string | null;
  serviceName: string | null;
  rating: number;
  comment: string | null;
  originalComment: string | null;
  redacted: boolean;
  authorDisplay: string;
  originalReviewedAt: Date;
  evidenceRef: string | null;
  publicSourceUrl: string | null;
}

export interface SiteScope {
  tenantId: string;
  clientId: string;
  siteId: string;
}

/** Resolve a site to its (tenant, client) — the platform screens start from a site. */
export async function getSiteScope(siteId: string): Promise<(SiteScope & { siteName: string; slug: string; timezone: string; clientName: string }) | null> {
  const r = await query<{ tenant_id: string; client_id: string; id: string; name: string; slug: string; timezone: string; client_name: string }>(
    `SELECT si.tenant_id, si.client_id, si.id, si.name, si.slug, si.timezone, c.name AS client_name
       FROM sites si JOIN clients c ON c.id = si.client_id AND c.tenant_id = si.tenant_id
      WHERE si.id = $1`,
    [siteId],
  );
  const x = r.rows[0];
  return x ? { tenantId: x.tenant_id, clientId: x.client_id, siteId: x.id, siteName: x.name, slug: x.slug, timezone: x.timezone, clientName: x.client_name } : null;
}

/** Sites matching a search (name or slug) — for the platform screen's site picker. */
export async function searchSites(q: string): Promise<Array<{ id: string; name: string; slug: string; client_name: string }>> {
  const r = await query<{ id: string; name: string; slug: string; client_name: string }>(
    `SELECT si.id, si.name, si.slug, c.name AS client_name
       FROM sites si JOIN clients c ON c.id = si.client_id AND c.tenant_id = si.tenant_id
      WHERE si.slug ILIKE $1 OR si.name ILIKE $1 OR c.name ILIKE $1
      ORDER BY si.name LIMIT 20`,
    [`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`],
  );
  return r.rows;
}

export async function listExternalReviewKeys(scope: SiteScope): Promise<Set<string>> {
  const r = await query<{ external_key: string }>(
    `SELECT external_key FROM appointment_reviews
      WHERE tenant_id = $1 AND client_id = $2 AND source = 'fresha' AND external_key IS NOT NULL`,
    [scope.tenantId, scope.clientId],
  );
  return new Set(r.rows.map((x) => x.external_key));
}

async function logEvent(c: PoolClient, tenantId: string, ev: { reviewId?: string | null; batchId?: string | null; type: string; actor: string | null; detail?: Record<string, unknown> }) {
  await c.query(
    `INSERT INTO review_events (tenant_id, review_id, batch_id, event_type, actor_user_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, ev.reviewId ?? null, ev.batchId ?? null, ev.type, ev.actor, JSON.stringify(ev.detail ?? {})],
  );
}

/**
 * Apply an import: ONE transaction — the batch, every new review (pending / provenance
 * pending, no consent, no appointment) and the audit event. Keys already imported are
 * skipped (ON CONFLICT DO NOTHING), so the same file twice adds nothing.
 *
 * Defence in depth on top of the planner: every staff_id must be a professional of THIS
 * site and every service_id a service of THIS client — otherwise nothing is written.
 */
export async function importExternalReviewBatch(input: SiteScope & {
  fileName: string | null;
  fileSha256: string;
  totals: { rows: number; duplicates: number; rejected: number };
  mapping: Record<string, unknown>;
  actor: string;
  rows: ExternalReviewInsert[];
}): Promise<{ batchId: string; inserted: number; skipped: number }> {
  return withTransaction(async (c) => {
    const site = await c.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [input.siteId, input.tenantId, input.clientId]);
    if (site.rowCount === 0) throw new Error('import refused: the site is not this client’s');
    const staffIds = [...new Set(input.rows.map((r) => r.staffId).filter((x): x is string => x !== null))];
    if (staffIds.length) {
      const st = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM staff WHERE tenant_id = $1 AND site_id = $2 AND id = ANY($3::uuid[])`, [input.tenantId, input.siteId, staffIds]);
      if (st.rows[0].n !== staffIds.length) throw new Error('import refused: a professional does not belong to this site');
    }
    const serviceIds = [...new Set(input.rows.map((r) => r.serviceId).filter((x): x is string => x !== null))];
    if (serviceIds.length) {
      const sv = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM services WHERE tenant_id = $1 AND client_id = $2 AND id = ANY($3::uuid[])`, [input.tenantId, input.clientId, serviceIds]);
      if (sv.rows[0].n !== serviceIds.length) throw new Error('import refused: a service does not belong to this client');
    }
    const b = await c.query<{ id: string }>(
      `INSERT INTO review_import_batches (tenant_id, client_id, site_id, source, file_name, file_sha256, total_rows, imported, duplicates, rejected, mapping, imported_by)
       VALUES ($1, $2, $3, 'fresha', $4, $5, $6, 0, $7, $8, $9, $10) RETURNING id`,
      [input.tenantId, input.clientId, input.siteId, input.fileName, input.fileSha256, input.totals.rows, input.totals.duplicates, input.totals.rejected, JSON.stringify(input.mapping), input.actor],
    );
    const batchId = b.rows[0].id;
    let inserted = 0;
    for (const r of input.rows) {
      const redactions = r.redacted ? [{ at: new Date().toISOString(), by: input.actor, reason: 'contact_or_link', step: 'import' }] : [];
      const res = await c.query(
        `INSERT INTO appointment_reviews
           (tenant_id, client_id, site_id, appointment_id, staff_id, service_id, service_name, status,
            rating, comment, author_display, publish_consent, expires_at, submitted_at,
            source, external_key, original_reviewed_at, import_batch_id, evidence_ref, public_source_url,
            original_comment, redactions, provenance_status)
         VALUES ($1, $2, $3, NULL, $4, $5, $6, 'pending', $7, $8, $9, false, NULL, now(),
                 'fresha', $10, $11, $12, $13, $14, $15, $16, 'pending')
         ON CONFLICT (tenant_id, client_id, source, external_key) WHERE external_key IS NOT NULL DO NOTHING`,
        [input.tenantId, input.clientId, input.siteId, r.staffId, r.serviceId, r.serviceName, r.rating, r.comment, r.authorDisplay,
         r.externalKey, r.originalReviewedAt, batchId, r.evidenceRef, r.publicSourceUrl, r.originalComment, JSON.stringify(redactions)],
      );
      inserted += res.rowCount ?? 0;
    }
    await c.query(`UPDATE review_import_batches SET imported = $2, duplicates = duplicates + $3 WHERE id = $1`, [batchId, inserted, input.rows.length - inserted]);
    await logEvent(c, input.tenantId, { batchId, type: 'imported', actor: input.actor, detail: { inserted, skipped: input.rows.length - inserted, rows: input.totals.rows } });
    return { batchId, inserted, skipped: input.rows.length - inserted };
  });
}

export interface PlatformExternalReviewRow {
  id: string;
  status: string;
  provenance_status: 'pending' | 'reviewed' | 'rejected';
  rating: number;
  comment: string | null;
  original_comment: string | null;
  redactions: Array<{ at: string; by: string | null; reason: string; step?: string }>;
  author_display: string;
  staff_name: string | null;
  service_name: string | null;
  service_counted: boolean;
  original_reviewed_at: Date;
  evidence_ref: string | null;
  public_source_url: string | null;
  provenance_notes: string | null;
  provenance_reviewed_at: Date | null;
  provenance_reviewer: string | null;
  imported_at: Date;
  importer: string | null;
  batch_file: string | null;
  open_requests: Array<{ id: string; kind: 'review' | 'withdraw'; note: string | null; created_at: string }>;
}

/** Everything a platform administrator reviews — internal fields included. */
export async function listExternalReviewsForPlatform(scope: SiteScope): Promise<PlatformExternalReviewRow[]> {
  const r = await query<PlatformExternalReviewRow>(
    `SELECT rv.id, rv.status, rv.provenance_status, rv.rating, rv.comment, rv.original_comment, rv.redactions,
            rv.author_display, st.name AS staff_name, rv.service_name, (rv.service_id IS NOT NULL) AS service_counted,
            rv.original_reviewed_at, rv.evidence_ref, rv.public_source_url, rv.provenance_notes, rv.provenance_reviewed_at,
            pu.name AS provenance_reviewer, b.created_at AS imported_at, iu.name AS importer, b.file_name AS batch_file,
            COALESCE((SELECT json_agg(json_build_object('id', q.id, 'kind', q.kind, 'note', q.note, 'created_at', q.created_at) ORDER BY q.created_at)
                        FROM external_review_requests q WHERE q.review_id = rv.id AND q.resolved_at IS NULL), '[]'::json) AS open_requests
       FROM appointment_reviews rv
       JOIN review_import_batches b ON b.id = rv.import_batch_id
       LEFT JOIN staff st ON st.id = rv.staff_id AND st.tenant_id = rv.tenant_id
       LEFT JOIN "user" pu ON pu.id = rv.provenance_reviewed_by
       LEFT JOIN "user" iu ON iu.id = b.imported_by
      WHERE rv.tenant_id = $1 AND rv.client_id = $2 AND rv.site_id = $3 AND rv.source = 'fresha'
      ORDER BY (rv.provenance_status = 'pending') DESC, rv.original_reviewed_at DESC
      LIMIT 500`,
    [scope.tenantId, scope.clientId, scope.siteId],
  );
  return r.rows;
}

type PlatformResult = { ok: true } | { ok: false; error: 'not_found' | 'needs_provenance' | 'invalid' };

async function lockExternal(c: PoolClient, scope: SiteScope, reviewId: string) {
  const r = await c.query<{ status: string; provenance_status: string; comment: string | null }>(
    `SELECT status, provenance_status, comment FROM appointment_reviews
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND site_id = $4 AND source = 'fresha' FOR UPDATE`,
    [reviewId, scope.tenantId, scope.clientId, scope.siteId],
  );
  return r.rows[0] ?? null;
}

/** The provenance review: a person checked the evidence (reviewed) or could not (rejected). */
export function reviewProvenance(scope: SiteScope, reviewId: string, decision: 'reviewed' | 'rejected', notes: string | null, actor: string): Promise<PlatformResult> {
  return withTransaction(async (c): Promise<PlatformResult> => {
    const row = await lockExternal(c, scope, reviewId);
    if (!row) return { ok: false, error: 'not_found' };
    // A rejected provenance takes the review off the page, whatever it was.
    await c.query(
      `UPDATE appointment_reviews
          SET provenance_status = $2, provenance_notes = $3, provenance_reviewed_by = $4, provenance_reviewed_at = now(),
              status = CASE WHEN $2 = 'rejected' THEN 'hidden' ELSE status END, updated_at = now()
        WHERE id = $1`,
      [reviewId, decision, notes, actor],
    );
    await logEvent(c, scope.tenantId, { reviewId, type: decision === 'reviewed' ? 'provenance_reviewed' : 'provenance_rejected', actor, detail: { notes: Boolean(notes) } });
    return { ok: true };
  });
}

/** Publish (approve) or hide. Publishing needs a reviewed provenance (also a DB CHECK). */
export function setExternalPublication(scope: SiteScope, reviewId: string, status: 'approved' | 'hidden', actor: string): Promise<PlatformResult> {
  return withTransaction(async (c): Promise<PlatformResult> => {
    const row = await lockExternal(c, scope, reviewId);
    if (!row) return { ok: false, error: 'not_found' };
    if (status === 'approved' && row.provenance_status !== 'reviewed') return { ok: false, error: 'needs_provenance' };
    await c.query(`UPDATE appointment_reviews SET status = $2, moderated_at = now(), moderated_by = $3, updated_at = now() WHERE id = $1`, [reviewId, status, actor]);
    await logEvent(c, scope.tenantId, { reviewId, type: status === 'approved' ? 'published' : 'hidden', actor });
    return { ok: true };
  });
}

/**
 * Change the PUBLIC text for privacy (never the stars, the author, the date or the
 * original): the original stays in original_comment and the change is appended to
 * `redactions` with who, when and why.
 */
export function redactExternalComment(scope: SiteScope, reviewId: string, publicText: string | null, reason: string, actor: string): Promise<PlatformResult> {
  return withTransaction(async (c): Promise<PlatformResult> => {
    const row = await lockExternal(c, scope, reviewId);
    if (!row) return { ok: false, error: 'not_found' };
    if (publicText !== null && (publicText.length > 600 || publicText.trim() === '')) return { ok: false, error: 'invalid' };
    const entry = { at: new Date().toISOString(), by: actor, reason: reason.slice(0, 200), step: 'manual' };
    await c.query(
      `UPDATE appointment_reviews SET comment = $2, redactions = redactions || $3::jsonb, updated_at = now() WHERE id = $1`,
      [reviewId, publicText, JSON.stringify([entry])],
    );
    await logEvent(c, scope.tenantId, { reviewId, type: 'redacted', actor, detail: { reason: entry.reason } });
    return { ok: true };
  });
}

/** Close a business request (the platform administrator decides; the business cannot). */
export function resolveExternalReviewRequest(scope: SiteScope, requestId: string, resolution: 'kept' | 'withdrawn' | 'corrected', actor: string): Promise<PlatformResult> {
  return withTransaction(async (c): Promise<PlatformResult> => {
    const r = await c.query<{ review_id: string }>(
      `UPDATE external_review_requests q SET resolved_at = now(), resolved_by = $4, resolution = $5
         FROM appointment_reviews rv
        WHERE q.id = $1 AND q.resolved_at IS NULL AND rv.id = q.review_id
          AND rv.tenant_id = $2 AND rv.client_id = $3 AND rv.site_id = $6 AND rv.source = 'fresha'
       RETURNING q.review_id`,
      [requestId, scope.tenantId, scope.clientId, actor, resolution, scope.siteId],
    );
    const reviewId = r.rows[0]?.review_id;
    if (!reviewId) return { ok: false, error: 'not_found' };
    if (resolution === 'withdrawn') {
      await c.query(`UPDATE appointment_reviews SET status = 'hidden', moderated_at = now(), moderated_by = $2, updated_at = now() WHERE id = $1`, [reviewId, actor]);
    }
    await logEvent(c, scope.tenantId, { reviewId, type: 'request_resolved', actor, detail: { resolution } });
    return { ok: true };
  });
}

// ── The business (read-only + requests) ─────────────────────────────────────────────

export interface ClientExternalReviewRow {
  id: string;
  status: string;
  provenance_status: string;
  rating: number;
  comment: string | null;
  author_display: string;
  staff_name: string | null;
  service_name: string | null;
  original_reviewed_at: Date;
  site_name: string;
  open_requests: Array<{ kind: 'review' | 'withdraw' }>;
}

/** What the business sees of its imported reviews: no evidence, notes or original text. */
export async function listExternalReviewsForClient(tenantId: string, clientId: string): Promise<ClientExternalReviewRow[]> {
  const r = await query<ClientExternalReviewRow>(
    `SELECT rv.id, rv.status, rv.provenance_status, rv.rating, rv.comment, rv.author_display, st.name AS staff_name,
            rv.service_name, rv.original_reviewed_at, si.name AS site_name,
            COALESCE((SELECT json_agg(json_build_object('kind', q.kind)) FROM external_review_requests q
                       WHERE q.review_id = rv.id AND q.resolved_at IS NULL), '[]'::json) AS open_requests
       FROM appointment_reviews rv
       JOIN sites si ON si.id = rv.site_id AND si.tenant_id = rv.tenant_id
       LEFT JOIN staff st ON st.id = rv.staff_id AND st.tenant_id = rv.tenant_id
      WHERE rv.tenant_id = $1 AND rv.client_id = $2 AND rv.source = 'fresha'
      ORDER BY rv.original_reviewed_at DESC
      LIMIT 500`,
    [tenantId, clientId],
  );
  return r.rows;
}

/** The business asks for a review or a withdrawal. One open request per kind. */
export async function createExternalReviewRequest(input: {
  tenantId: string;
  clientId: string;
  reviewId: string;
  kind: 'review' | 'withdraw';
  note: string | null;
  actor: string;
}): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'already_open' }> {
  try {
    return await withTransaction(async (c) => {
      const r = await c.query(
        `INSERT INTO external_review_requests (tenant_id, client_id, review_id, kind, note, requested_by)
         SELECT rv.tenant_id, rv.client_id, rv.id, $4, $5, $6 FROM appointment_reviews rv
          WHERE rv.id = $3 AND rv.tenant_id = $1 AND rv.client_id = $2 AND rv.source = 'fresha'`,
        [input.tenantId, input.clientId, input.reviewId, input.kind, input.note, input.actor],
      );
      if (r.rowCount === 0) return { ok: false as const, error: 'not_found' as const };
      await logEvent(c, input.tenantId, { reviewId: input.reviewId, type: 'request_created', actor: input.actor, detail: { kind: input.kind } });
      return { ok: true as const };
    });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') return { ok: false, error: 'already_open' };
    throw err;
  }
}

/** The site's professionals (active or not — a former artist keeps their reviews) and the
 *  client's services: the only ids an import may map to. */
export async function importCatalog(scope: SiteScope): Promise<{ staff: Array<{ id: string; name: string }>; services: Array<{ id: string; name: string }> }> {
  const [st, sv] = await Promise.all([
    query<{ id: string; name: string }>(`SELECT id, name FROM staff WHERE tenant_id = $1 AND site_id = $2 ORDER BY name`, [scope.tenantId, scope.siteId]),
    query<{ id: string; name: string }>(`SELECT id, name FROM services WHERE tenant_id = $1 AND client_id = $2 ORDER BY name`, [scope.tenantId, scope.clientId]),
  ]);
  return { staff: st.rows, services: sv.rows };
}
