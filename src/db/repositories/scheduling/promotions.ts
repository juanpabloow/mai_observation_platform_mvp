import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../client.js';
import { canMove, isOnOffer, publishProblems, type BenefitType, type PromotionRules, type PromotionStatus } from '../../../scheduling/promotions.js';
import { publicServicePredicate } from './publicCatalog.js';

/**
 * PROMOTIONS repository (migration 1805). Per CLIENT: every read and write is scoped by
 * (tenant_id, client_id), and the services, staff and site a promotion names must be the
 * SAME client's — checked in SQL inside the write's transaction, so a forged id from
 * another client aborts the whole write.
 *
 * Every write:
 *   - names the `version` it read; a stale version is refused (`stale`) instead of
 *     overwriting someone else's edit;
 *   - appends a promotion_events row with the actor, in the same transaction.
 * There is no delete: a promotion ends its life `archived`.
 */

export interface PromotionRow {
  id: string;
  site_id: string | null;
  name: string;
  description: string | null;
  conditions: string | null;
  image_url: string | null;
  sort_order: number;
  status: PromotionStatus;
  benefit_type: BenefitType;
  benefit_params: Record<string, unknown>;
  bookable_from: Date | null;
  bookable_until: Date | null;
  appointment_weekdays: number[] | null;
  appointment_from: string | null;
  appointment_until: string | null;
  appointment_time_from: string | null;
  appointment_time_until: string | null;
  version: number;
  service_ids: string[];
  staff_ids: string[];
  published_at: Date | null;
  updated_at: Date;
  /** Appointments booked with it — a referenced promotion can never be deleted. */
  booked_count: number;
}

const SELECT = `
  SELECT p.id, p.site_id, p.name, p.description, p.conditions, p.image_url, p.sort_order, p.status,
         p.benefit_type, p.benefit_params, p.bookable_from, p.bookable_until, p.appointment_weekdays,
         to_char(p.appointment_from, 'YYYY-MM-DD') AS appointment_from,
         to_char(p.appointment_until, 'YYYY-MM-DD') AS appointment_until,
         to_char(p.appointment_time_from, 'HH24:MI') AS appointment_time_from,
         to_char(p.appointment_time_until, 'HH24:MI') AS appointment_time_until,
         p.version, p.published_at, p.updated_at,
         ARRAY(SELECT ps.service_id FROM promotion_services ps WHERE ps.promotion_id = p.id ORDER BY ps.service_id) AS service_ids,
         ARRAY(SELECT pt.staff_id FROM promotion_staff pt WHERE pt.promotion_id = p.id ORDER BY pt.staff_id) AS staff_ids,
         (SELECT count(*)::int FROM appointments a WHERE a.promotion_id = p.id) AS booked_count
    FROM promotions p`;

export async function listPromotions(tenantId: string, clientId: string): Promise<PromotionRow[]> {
  const r = await query<PromotionRow>(`${SELECT} WHERE p.tenant_id = $1 AND p.client_id = $2 ORDER BY (p.status = 'archived'), p.sort_order, lower(p.name)`, [tenantId, clientId]);
  return r.rows;
}

export async function getPromotion(tenantId: string, clientId: string, id: string, client?: PoolClient): Promise<PromotionRow | null> {
  const sql = `${SELECT} WHERE p.id = $1 AND p.tenant_id = $2 AND p.client_id = $3`;
  const r = client ? await client.query<PromotionRow>(sql, [id, tenantId, clientId]) : await query<PromotionRow>(sql, [id, tenantId, clientId]);
  return r.rows[0] ?? null;
}

export interface PromotionInput {
  site_id: string | null;
  name: string;
  description: string | null;
  conditions: string | null;
  sort_order: number;
  benefit_type: BenefitType;
  benefit_params: Record<string, unknown>;
  bookable_from: Date | null;
  bookable_until: Date | null;
  appointment_weekdays: number[] | null;
  appointment_from: string | null;
  appointment_until: string | null;
  appointment_time_from: string | null;
  appointment_time_until: string | null;
  service_ids: string[];
  staff_ids: string[];
}

export type WriteResult = { ok: true; id: string; version: number } | { ok: false; error: 'not_found' | 'stale' | 'foreign' | 'invalid_move' | 'cannot_publish'; problems?: string[] };

class ForeignRef extends Error {}

/** Link services/staff and check the site — all of THIS client, or the write aborts. */
async function writeLinks(c: PoolClient, tenantId: string, clientId: string, promotionId: string, input: PromotionInput): Promise<void> {
  if (input.site_id) {
    const s = await c.query(`SELECT 1 FROM sites WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [input.site_id, tenantId, clientId]);
    if (s.rowCount === 0) throw new ForeignRef('site');
  }
  await c.query(`DELETE FROM promotion_services WHERE promotion_id = $1`, [promotionId]);
  await c.query(`DELETE FROM promotion_staff WHERE promotion_id = $1`, [promotionId]);
  const services = [...new Set(input.service_ids)];
  if (services.length) {
    const r = await c.query(
      `INSERT INTO promotion_services (promotion_id, service_id, tenant_id)
         SELECT $1, sv.id, $2 FROM services sv WHERE sv.id = ANY($4::uuid[]) AND sv.tenant_id = $2 AND sv.client_id = $3`,
      [promotionId, tenantId, clientId, services],
    );
    if (r.rowCount !== services.length) throw new ForeignRef('service');
  }
  const staff = [...new Set(input.staff_ids)];
  if (staff.length) {
    const r = await c.query(
      `INSERT INTO promotion_staff (promotion_id, staff_id, tenant_id)
         SELECT $1, st.id, $2 FROM staff st JOIN sites si ON si.id = st.site_id AND si.tenant_id = st.tenant_id
          WHERE st.id = ANY($4::uuid[]) AND st.tenant_id = $2 AND si.client_id = $3`,
      [promotionId, tenantId, clientId, staff],
    );
    if (r.rowCount !== staff.length) throw new ForeignRef('staff');
  }
}

async function logEvent(c: PoolClient, tenantId: string, promotionId: string, type: string, actor: string | null, version: number, detail: Record<string, unknown> = {}): Promise<void> {
  await c.query(
    `INSERT INTO promotion_events (tenant_id, promotion_id, event_type, actor_user_id, version, detail) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, promotionId, type, actor, version, JSON.stringify(detail)],
  );
}

const FIELDS = (i: PromotionInput) => [
  i.site_id,
  i.name,
  i.description,
  i.conditions,
  i.sort_order,
  i.benefit_type,
  JSON.stringify(i.benefit_params),
  i.bookable_from,
  i.bookable_until,
  i.appointment_weekdays,
  i.appointment_from,
  i.appointment_until,
  i.appointment_time_from,
  i.appointment_time_until,
];

async function guarded<T extends WriteResult>(fn: () => Promise<T>): Promise<WriteResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForeignRef) return { ok: false, error: 'foreign' };
    throw err;
  }
}

export function createPromotion(tenantId: string, clientId: string, input: PromotionInput, actor: string | null): Promise<WriteResult> {
  return guarded(() =>
    withTransaction(async (c) => {
      const r = await c.query<{ id: string }>(
        `INSERT INTO promotions (tenant_id, client_id, site_id, name, description, conditions, sort_order, benefit_type, benefit_params,
                                 bookable_from, bookable_until, appointment_weekdays, appointment_from, appointment_until,
                                 appointment_time_from, appointment_time_until, created_by, updated_by)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17
            WHERE EXISTS (SELECT 1 FROM clients WHERE id = $2 AND tenant_id = $1)
         RETURNING id`,
        [tenantId, clientId, ...FIELDS(input), actor],
      );
      const id = r.rows[0]?.id;
      if (!id) throw new ForeignRef('client');
      await writeLinks(c, tenantId, clientId, id, input);
      await logEvent(c, tenantId, id, 'created', actor, 1);
      return { ok: true as const, id, version: 1 };
    }),
  );
}

export function updatePromotion(
  tenantId: string,
  clientId: string,
  id: string,
  expectedVersion: number,
  input: PromotionInput,
  actor: string | null,
): Promise<WriteResult> {
  return guarded(() =>
    withTransaction(async (c): Promise<WriteResult> => {
      const before = await getPromotion(tenantId, clientId, id, c);
      if (!before) return { ok: false, error: 'not_found' };
      if (before.version !== expectedVersion) return { ok: false, error: 'stale' };
      if (before.status === 'archived') return { ok: false, error: 'invalid_move' };
      // A published promotion must stay publishable after the edit.
      if (before.status === 'published') {
        const problems = publishProblems({ ...rulesOf({ ...before, ...input }), name: input.name });
        if (problems.length) return { ok: false, error: 'cannot_publish', problems };
      }
      const r = await c.query<{ version: number }>(
        `UPDATE promotions
            SET site_id = $5, name = $6, description = $7, conditions = $8, sort_order = $9, benefit_type = $10, benefit_params = $11,
                bookable_from = $12, bookable_until = $13, appointment_weekdays = $14, appointment_from = $15, appointment_until = $16,
                appointment_time_from = $17, appointment_time_until = $18,
                version = version + 1, updated_by = $19, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND version = $4
          RETURNING version`,
        [id, tenantId, clientId, expectedVersion, ...FIELDS(input), actor],
      );
      if (!r.rows[0]) return { ok: false, error: 'stale' };
      await writeLinks(c, tenantId, clientId, id, input);
      const changed = (Object.keys(input) as Array<keyof PromotionInput>).filter((k) => JSON.stringify(input[k]) !== JSON.stringify((before as unknown as Record<string, unknown>)[k]));
      await logEvent(c, tenantId, id, 'updated', actor, r.rows[0].version, { changed });
      return { ok: true, id, version: r.rows[0].version };
    }),
  );
}

/** Publish / pause / resume / archive — only the allowed moves; publishing re-validates. */
export function setPromotionStatus(
  tenantId: string,
  clientId: string,
  id: string,
  expectedVersion: number,
  to: PromotionStatus,
  actor: string | null,
): Promise<WriteResult> {
  return guarded(() =>
    withTransaction(async (c): Promise<WriteResult> => {
      const before = await getPromotion(tenantId, clientId, id, c);
      if (!before) return { ok: false, error: 'not_found' };
      if (before.version !== expectedVersion) return { ok: false, error: 'stale' };
      if (!canMove(before.status, to)) return { ok: false, error: 'invalid_move' };
      if (to === 'published') {
        const problems = publishProblems({ ...rulesOf(before), name: before.name });
        if (problems.length) return { ok: false, error: 'cannot_publish', problems };
      }
      const r = await c.query<{ version: number }>(
        `UPDATE promotions
            SET status = $5, version = version + 1, updated_by = $6, updated_at = now(),
                published_at = CASE WHEN $5 = 'published' THEN now() ELSE published_at END,
                published_by = CASE WHEN $5 = 'published' THEN $6 ELSE published_by END
          WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND version = $4
          RETURNING version`,
        [id, tenantId, clientId, expectedVersion, to, actor],
      );
      if (!r.rows[0]) return { ok: false, error: 'stale' };
      const type = to === 'published' ? (before.status === 'paused' ? 'resumed' : 'published') : to;
      await logEvent(c, tenantId, id, type, actor, r.rows[0].version, { from: before.status });
      return { ok: true, id, version: r.rows[0].version };
    }),
  );
}

/** A DRAFT copy ("Copia de …") — the original, and its bookings, are untouched. */
export async function duplicatePromotion(tenantId: string, clientId: string, id: string, actor: string | null): Promise<WriteResult> {
  const src = await getPromotion(tenantId, clientId, id);
  if (!src) return { ok: false, error: 'not_found' };
  const name = `Copia de ${src.name}`.slice(0, 80);
  const r = await createPromotion(tenantId, clientId, { ...inputOf(src), name }, actor);
  if (r.ok) {
    await query(
      `INSERT INTO promotion_events (tenant_id, promotion_id, event_type, actor_user_id, version, detail) VALUES ($1, $2, 'duplicated', $3, 1, $4)`,
      [tenantId, r.id, actor, JSON.stringify({ source: id })],
    );
  }
  return r;
}

export interface PromotionEventRow {
  event_type: string;
  actor_name: string | null;
  version: number;
  detail: Record<string, unknown>;
  created_at: Date;
}

export async function listPromotionEvents(tenantId: string, clientId: string, id: string): Promise<PromotionEventRow[]> {
  const r = await query<PromotionEventRow>(
    `SELECT e.event_type, u.name AS actor_name, e.version, e.detail, e.created_at
       FROM promotion_events e
       JOIN promotions p ON p.id = e.promotion_id AND p.tenant_id = e.tenant_id
       LEFT JOIN "user" u ON u.id = e.actor_user_id
      WHERE e.promotion_id = $1 AND e.tenant_id = $2 AND p.client_id = $3
      ORDER BY e.created_at DESC
      LIMIT 50`,
    [id, tenantId, clientId],
  );
  return r.rows;
}

/**
 * What the PUBLIC page may show: published promotions on offer now (window A) for this
 * site, keeping only the included services that are themselves on the page. A promotion
 * left with no such service is not shown.
 */
export async function listPublicPromotions(tenantId: string, siteId: string, now: Date): Promise<PromotionRow[]> {
  const r = await query<PromotionRow>(
    `${SELECT}
       JOIN sites si ON si.id = $2 AND si.tenant_id = p.tenant_id AND si.client_id = p.client_id AND si.active = true
      WHERE p.tenant_id = $1 AND p.status = 'published' AND (p.site_id IS NULL OR p.site_id = si.id)
      ORDER BY p.sort_order, lower(p.name)`,
    [tenantId, siteId],
  );
  const publicIds = await query<{ id: string }>(
    `SELECT sv.id FROM sites si
       JOIN site_services ss ON ss.site_id = si.id AND ss.tenant_id = si.tenant_id AND ss.active = true
       JOIN services sv ON sv.id = ss.service_id AND sv.tenant_id = si.tenant_id AND sv.client_id = si.client_id AND sv.active = true
      WHERE si.tenant_id = $1 AND si.id = $2 AND ${publicServicePredicate('sv', 'si')}`,
    [tenantId, siteId],
  );
  const onPage = new Set(publicIds.rows.map((x) => x.id));
  return r.rows
    .filter((p) => isOnOffer(p, now))
    .map((p) => ({ ...p, service_ids: p.service_ids.filter((s) => onPage.has(s)) }))
    .filter((p) => p.service_ids.length > 0);
}

type RuleKeys = keyof PromotionRules;
export function rulesOf(p: Pick<PromotionRow, RuleKeys>): PromotionRules {
  return {
    status: p.status,
    benefit_type: p.benefit_type,
    benefit_params: p.benefit_params,
    site_id: p.site_id,
    service_ids: p.service_ids,
    staff_ids: p.staff_ids,
    bookable_from: p.bookable_from,
    bookable_until: p.bookable_until,
    appointment_weekdays: p.appointment_weekdays,
    appointment_from: p.appointment_from,
    appointment_until: p.appointment_until,
    appointment_time_from: p.appointment_time_from,
    appointment_time_until: p.appointment_time_until,
  };
}

function inputOf(p: PromotionRow): PromotionInput {
  return {
    site_id: p.site_id,
    name: p.name,
    description: p.description,
    conditions: p.conditions,
    sort_order: p.sort_order,
    benefit_type: p.benefit_type,
    benefit_params: p.benefit_params,
    bookable_from: p.bookable_from,
    bookable_until: p.bookable_until,
    appointment_weekdays: p.appointment_weekdays,
    appointment_from: p.appointment_from,
    appointment_until: p.appointment_until,
    appointment_time_from: p.appointment_time_from,
    appointment_time_until: p.appointment_time_until,
    service_ids: p.service_ids,
    staff_ids: p.staff_ids,
  };
}

/** Set (or clear) a promotion's image; returns the previous URL for cleanup. */
export async function setPromotionImage(tenantId: string, clientId: string, id: string, url: string | null): Promise<{ ok: boolean; previous: string | null }> {
  const r = await query<{ previous: string | null }>(
    `UPDATE promotions p SET image_url = $4, updated_at = now()
       FROM (SELECT image_url AS previous FROM promotions WHERE id = $1 AND tenant_id = $2 AND client_id = $3) old
      WHERE p.id = $1 AND p.tenant_id = $2 AND p.client_id = $3
      RETURNING old.previous`,
    [id, tenantId, clientId, url],
  );
  return r.rows[0] ? { ok: true, previous: r.rows[0].previous } : { ok: false, previous: null };
}
