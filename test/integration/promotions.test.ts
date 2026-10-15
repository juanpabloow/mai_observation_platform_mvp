import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import {
  createPromotion,
  duplicatePromotion,
  getPromotion,
  listPromotionEvents,
  listPublicPromotions,
  setPromotionStatus,
  updatePromotion,
  type PromotionInput,
} from '../../src/db/repositories/scheduling/promotions.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { OPEN_9_18, cleanupTenant, closeDb, seedMember } from './fixtures.js';

/**
 * PROMOTIONS (migration 1805) against the real database: same-client links, optimistic
 * concurrency, the audit trail, the publish gate, the public read (window A), past
 * bookings frozen by their snapshot, and the public POST that never lets a promotion —
 * or an ad link carrying one — bypass the rules.
 */

const TZ = 'America/Bogota';
const tenants: string[] = [];
const SAVED_SECRET = process.env.PUBLIC_BOOKING_HASH_SECRET;
process.env.PUBLIC_BOOKING_HASH_SECRET = 'test-public-booking-hash-secret-0123456789';
after(async () => {
  if (SAVED_SECRET === undefined) delete process.env.PUBLIC_BOOKING_HASH_SECRET;
  else process.env.PUBLIC_BOOKING_HASH_SECRET = SAVED_SECRET;
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

function nextWeekday(iso: number, weeksAhead = 3): { y: number; m: number; d: number } {
  const base = new Date(Date.now() + weeksAhead * 7 * 86_400_000);
  const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  for (let i = 0; i < 7; i++) {
    const day = new Date(base.getTime() + i * 86_400_000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(day);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    if (get('weekday') === names[iso]) return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
  }
  throw new Error('no day');
}
const atDay = (day: { y: number; m: number; d: number }, h: number) => zonedPartsToUtc(day.y, day.m, day.d, h, 0, TZ);

async function mkBiz() {
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `T ${tenantId.slice(0, 8)}`]);
  tenants.push(tenantId);
  const c = await query<{ id: string }>(`INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`, [tenantId, `Biz ${randomUUID().slice(0, 6)}`]);
  const clientId = c.rows[0].id;
  const slug = `promo-${randomUUID().slice(0, 10)}`;
  const s = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Sede', $4, $5, '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, TZ, JSON.stringify(OPEN_9_18)],
  );
  const siteId = s.rows[0].id;
  const sv = await query<{ id: string }>(`INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, 'Corte', 60, 60000) RETURNING id`, [tenantId, clientId]);
  const serviceId = sv.rows[0].id;
  await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, serviceId]);
  const st = await query<{ id: string }>(`INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, 'Ana', '{}'::jsonb) RETURNING id`, [tenantId, siteId]);
  const staffId = st.rows[0].id;
  await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, staffId, serviceId]);
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  const actor = await seedMember(tenantId, { role: 'owner' });
  return { tenantId, clientId, siteId, slug, serviceId, staffId, actor };
}

const input = (serviceId: string, over: Partial<PromotionInput> = {}): PromotionInput => ({
  site_id: null,
  name: '2×1 universitario',
  description: 'Trae a un amigo.',
  conditions: null,
  sort_order: 0,
  benefit_type: 'two_for_one',
  benefit_params: {},
  bookable_from: null,
  bookable_until: null,
  appointment_weekdays: [1, 2],
  appointment_from: null,
  appointment_until: null,
  appointment_time_from: null,
  appointment_time_until: null,
  service_ids: [serviceId],
  staff_ids: [],
  ...over,
});

test('drafts link only THIS client’s services; foreign ids abort the whole write', async () => {
  const a = await mkBiz();
  const b = await mkBiz();
  const bad = await createPromotion(a.tenantId, a.clientId, input(b.serviceId), a.actor);
  assert.deepEqual(bad, { ok: false, error: 'foreign' });
  assert.equal((await query(`SELECT count(*)::int AS n FROM promotions WHERE tenant_id = $1`, [a.tenantId])).rows[0].n, 0, 'rolled back');
  const badStaff = await createPromotion(a.tenantId, a.clientId, input(a.serviceId, { staff_ids: [b.staffId] }), a.actor);
  assert.equal(badStaff.ok, false);
  const ok = await createPromotion(a.tenantId, a.clientId, input(a.serviceId), a.actor);
  assert.equal(ok.ok, true);
  assert.equal(await getPromotion(b.tenantId, b.clientId, ok.ok ? ok.id : ''), null, 'invisible to another client');
});

test('versions: a stale edit is refused, nothing overwritten; every change is in the audit trail with its actor', async () => {
  const a = await mkBiz();
  const c = await createPromotion(a.tenantId, a.clientId, input(a.serviceId), a.actor);
  assert.ok(c.ok);
  const first = await updatePromotion(a.tenantId, a.clientId, c.id, 1, input(a.serviceId, { name: 'Edición A' }), a.actor);
  assert.deepEqual(first, { ok: true, id: c.id, version: 2 });
  const second = await updatePromotion(a.tenantId, a.clientId, c.id, 1, input(a.serviceId, { name: 'Edición B (vieja)' }), a.actor);
  assert.deepEqual(second, { ok: false, error: 'stale' });
  assert.equal((await getPromotion(a.tenantId, a.clientId, c.id))?.name, 'Edición A');
  const events = await listPromotionEvents(a.tenantId, a.clientId, c.id);
  assert.deepEqual(events.map((e) => e.event_type), ['updated', 'created']);
  assert.ok(events.every((e) => e.actor_name?.startsWith('U ')), 'the actor is recorded');
  assert.deepEqual(events[0].detail, { changed: ['name'] });
});

test('the 2×1 cannot be published (pending rules); draft → archived is terminal; duplicate makes a new draft', async () => {
  const a = await mkBiz();
  const c = await createPromotion(a.tenantId, a.clientId, input(a.serviceId), a.actor);
  assert.ok(c.ok);
  const pub = await setPromotionStatus(a.tenantId, a.clientId, c.id, 1, 'published', a.actor);
  assert.equal(pub.ok, false);
  assert.equal(!pub.ok && pub.error, 'cannot_publish');
  assert.match(!pub.ok ? (pub.problems ?? []).join(' ') : '', /dos personas/);
  assert.equal((await getPromotion(a.tenantId, a.clientId, c.id))?.status, 'draft');
  assert.deepEqual(await setPromotionStatus(a.tenantId, a.clientId, c.id, 1, 'paused', a.actor), { ok: false, error: 'invalid_move' });

  const copy = await duplicatePromotion(a.tenantId, a.clientId, c.id, a.actor);
  assert.ok(copy.ok);
  const copied = await getPromotion(a.tenantId, a.clientId, copy.id);
  assert.equal(copied?.name, 'Copia de 2×1 universitario');
  assert.equal(copied?.status, 'draft');
  assert.deepEqual((await listPromotionEvents(a.tenantId, a.clientId, copy.id)).map((e) => e.event_type).sort(), ['created', 'duplicated']);

  const arch = await setPromotionStatus(a.tenantId, a.clientId, c.id, 1, 'archived', a.actor);
  assert.ok(arch.ok);
  assert.deepEqual(await updatePromotion(a.tenantId, a.clientId, c.id, 2, input(a.serviceId), a.actor), { ok: false, error: 'invalid_move' });
});

test('public read (window A): only published + on offer + services on the page; paused/archived/out of dates never', async () => {
  const a = await mkBiz();
  const mk = async (over: Partial<PromotionInput>, status: string) => {
    const c = await createPromotion(a.tenantId, a.clientId, input(a.serviceId, over), a.actor);
    assert.ok(c.ok);
    // Status forced in SQL: the app cannot publish a 2×1 yet (see above) — this checks the READ.
    await query(`UPDATE promotions SET status = $2 WHERE id = $1`, [c.id, status]);
    return c.id;
  };
  const now = new Date();
  const live = await mk({ name: 'Viva' }, 'published');
  await mk({ name: 'Pausada' }, 'paused');
  await mk({ name: 'Archivada' }, 'archived');
  await mk({ name: 'Futura', bookable_from: new Date(now.getTime() + 86_400_000) }, 'published');
  await mk({ name: 'Vencida', bookable_until: new Date(now.getTime() - 60_000) }, 'published');
  assert.deepEqual((await listPublicPromotions(a.tenantId, a.siteId, now)).map((p) => p.id), [live]);
  await query(`UPDATE services SET public_visible = false WHERE id = $1`, [a.serviceId]);
  assert.deepEqual(await listPublicPromotions(a.tenantId, a.siteId, now), [], 'no service on the page → not shown');
});

test('past bookings keep their snapshot; a referenced promotion cannot be deleted', async () => {
  const a = await mkBiz();
  const c = await createPromotion(a.tenantId, a.clientId, input(a.serviceId), a.actor);
  assert.ok(c.ok);
  const monday = nextWeekday(1);
  const snapshot = { name: '2×1 universitario', benefit: 'two_for_one', conditions: 'Citas lunes y martes', price: '60000.00' };
  const appt = await query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
                               service_name_snapshot, duration_min_snapshot, price_snapshot, origin, created_by_type, promotion_id, promotion_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7, 'Corte', 60, 60000, 'internal', 'agent', $8, $9) RETURNING id`,
    [a.tenantId, a.clientId, a.siteId, a.staffId, a.serviceId, atDay(monday, 10), atDay(monday, 11), c.id, JSON.stringify(snapshot)],
  );
  await updatePromotion(a.tenantId, a.clientId, c.id, 1, input(a.serviceId, { name: 'Renombrada', appointment_weekdays: [3] }), a.actor);
  await setPromotionStatus(a.tenantId, a.clientId, c.id, 2, 'archived', a.actor);
  const row = (await query(`SELECT promotion_id, promotion_snapshot, price_snapshot FROM appointments WHERE id = $1`, [appt.rows[0].id])).rows[0];
  assert.deepEqual(row.promotion_snapshot, snapshot, 'the booking still says what it was booked with');
  assert.equal(row.promotion_id, c.id);
  await assert.rejects(query(`DELETE FROM promotions WHERE id = $1`, [c.id]), /violates foreign key/);
  assert.equal((await getPromotion(a.tenantId, a.clientId, c.id))?.booked_count, 1);
});

test('the public POST never books a promotion — draft, foreign, or even "published" via an ad link', async () => {
  const a = await mkBiz();
  const b = await mkBiz();
  const c = await createPromotion(a.tenantId, a.clientId, input(a.serviceId), a.actor);
  const foreign = await createPromotion(b.tenantId, b.clientId, input(b.serviceId), b.actor);
  assert.ok(c.ok && foreign.ok);
  const POST = (await import('../../web/app/api/booking/[slug]/route.js')).POST as (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
  const book = async (promotionId: string, startAt: Date) => {
    const res = await POST(
      new Request(`http://localhost/api/booking/${a.slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'idempotency-key': randomUUID() },
        body: JSON.stringify({
          service_id: a.serviceId,
          start_at: startAt.toISOString(),
          customer_name: 'Cliente Sintético',
          customer_phone: `31${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
          privacy_accepted: true,
          promotion_id: promotionId,
        }),
      }),
      { params: Promise.resolve({ slug: a.slug }) },
    );
    return { status: res.status, body: (await res.json()) as { error?: { code: string; reasons: Array<{ code: string }> } } };
  };
  const monday = nextWeekday(1);
  const wednesday = nextWeekday(3);

  const draft = await book(c.id, atDay(monday, 10));
  assert.equal(draft.status, 409);
  assert.equal(draft.body.error?.code, 'promotion_not_applicable');
  assert.deepEqual(draft.body.error?.reasons.map((r) => r.code), ['not_published', 'benefit_not_bookable']);

  assert.deepEqual((await book(foreign.id, atDay(monday, 10))).body.error?.reasons.map((r) => r.code), ['not_published'], 'another client’s id is unknown here');

  // Even if it were published (forced in SQL) and the ad link points at it:
  await query(`UPDATE promotions SET status = 'published' WHERE id = $1`, [c.id]);
  assert.deepEqual((await book(c.id, atDay(monday, 11))).body.error?.reasons.map((r) => r.code), ['benefit_not_bookable'], 'Monday passes every rule — still not booked');
  assert.deepEqual((await book(c.id, atDay(wednesday, 11))).body.error?.reasons.map((r) => r.code), ['weekday', 'benefit_not_bookable'], 'Wednesday: explained');
  assert.equal((await query(`SELECT count(*)::int AS n FROM appointments WHERE site_id = $1`, [a.siteId])).rows[0].n, 0, 'zero bookings');
});
