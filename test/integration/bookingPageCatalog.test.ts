import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, afterEach, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { listBookableServicesForSite, listServicesForSite } from '../../src/db/repositories/scheduling/services.js';
import { createBookingCategory, updateServicePresentation } from '../../src/db/repositories/scheduling/bookingCategories.js';
import { publicSiteRating } from '../../src/db/repositories/scheduling/reviews.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { OPEN_9_18, cleanupTenant, closeDb } from './fixtures.js';

/**
 * BOOKING PAGE CATALOG (migration 1804) end to end through the public route handlers:
 *  - hiding a service from the PAGE hides it from the list, the staff list, availability
 *    and the POST — while the agenda and the bot keep it (one predicate, one place);
 *  - a `contact` group or a hidden group hides its services from the page;
 *  - a category / upgrade of ANOTHER client can never be attached;
 *  - the price guard: a price changed between selection and confirmation is refused with
 *    the current price and ZERO writes; the shown price books normally;
 *  - the business rating counts every approved review of the site.
 */

const TZ = 'America/Bogota';
type Handler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
const routes = {
  post: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/route.js')).POST,
  services: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/services/route.js')).GET,
  staff: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/staff/route.js')).GET,
  availability: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/availability/route.js')).GET,
};

const SAVED_SECRET = process.env.PUBLIC_BOOKING_HASH_SECRET;
const SAVED_TURNSTILE = process.env.PUBLIC_BOOKING_TURNSTILE_ENABLED;
function resetEnv(): void {
  process.env.PUBLIC_BOOKING_HASH_SECRET = 'test-public-booking-hash-secret-0123456789';
  delete process.env.PUBLIC_BOOKING_TURNSTILE_ENABLED;
  delete process.env.PUBLIC_BOOKING_DISABLED;
}
resetEnv();
afterEach(resetEnv);

const tenants: string[] = [];
after(async () => {
  if (SAVED_SECRET === undefined) delete process.env.PUBLIC_BOOKING_HASH_SECRET;
  else process.env.PUBLIC_BOOKING_HASH_SECRET = SAVED_SECRET;
  if (SAVED_TURNSTILE !== undefined) process.env.PUBLIC_BOOKING_TURNSTILE_ENABLED = SAVED_TURNSTILE;
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

function futureWednesday(weeksAhead = 4): { y: number; m: number; d: number } {
  const base = new Date(Date.now() + weeksAhead * 7 * 86_400_000);
  for (let i = 0; i < 7; i++) {
    const day = new Date(base.getTime() + i * 86_400_000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(day);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    if (get('weekday') === 'Wed') return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
  }
  throw new Error('no wednesday');
}
const WED = futureWednesday();
const at = (h: number, min = 0): Date => zonedPartsToUtc(WED.y, WED.m, WED.d, h, min, TZ);

interface Fx {
  tenantId: string;
  clientId: string;
  siteId: string;
  slug: string;
  serviceId: string;
  hiddenId: string;
  staffId: string;
}

async function mkSite(): Promise<Fx> {
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `T ${tenantId.slice(0, 8)}`]);
  tenants.push(tenantId);
  const c = await query<{ id: string }>(`INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`, [tenantId, `Biz ${randomUUID().slice(0, 6)}`]);
  const clientId = c.rows[0].id;
  const slug = `bpc-${randomUUID().slice(0, 10)}`;
  const s = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, address, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Sede Centro', 'Calle 1 # 2-3', $4, $5,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, TZ, JSON.stringify(OPEN_9_18)],
  );
  const siteId = s.rows[0].id;
  const mkService = async (name: string, price: number) => {
    const r = await query<{ id: string }>(
      `INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, $3, 60, $4) RETURNING id`,
      [tenantId, clientId, name, price],
    );
    await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, r.rows[0].id]);
    return r.rows[0].id;
  };
  const serviceId = await mkService('Corte', 60000);
  const hiddenId = await mkService('Ritual suelto', 70000);
  const st = await query<{ id: string }>(`INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, 'Ana', '{}'::jsonb) RETURNING id`, [tenantId, siteId]);
  const staffId = st.rows[0].id;
  for (const svc of [serviceId, hiddenId]) {
    await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, staffId, svc]);
  }
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  return { tenantId, clientId, siteId, slug, serviceId, hiddenId, staffId };
}

const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
async function get(kind: 'services' | 'staff' | 'availability', slug: string, qs = ''): Promise<Response> {
  return (await routes[kind]())(new Request(`http://localhost/api/booking/${slug}/${kind}${qs}`, { headers: { 'x-forwarded-for': ip() } }), ctx(slug));
}
let seq = 0;
const phone = () => `30${String(20_000_000 + ((Date.now() + seq++ * 7919) % 79_999_999)).padStart(8, '0')}`;
async function post(slug: string, payload: Record<string, unknown>): Promise<Response> {
  return (await routes.post())(
    new Request(`http://localhost/api/booking/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip(), 'idempotency-key': randomUUID() },
      body: JSON.stringify(payload),
    }),
    ctx(slug),
  );
}
const booking = (fx: Fx, over: Record<string, unknown> = {}) => ({
  service_id: fx.serviceId,
  start_at: at(10).toISOString(),
  customer_name: 'Cliente Sintético',
  customer_phone: phone(),
  privacy_accepted: true,
  ...over,
});
const countAppts = async (fx: Fx) => (await query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE site_id = $1`, [fx.siteId])).rows[0].n;
const window14 = () => `&from=${encodeURIComponent(at(0).toISOString())}&to=${encodeURIComponent(new Date(at(0).getTime() + 86_400_000).toISOString())}`;

test('hidden from the PAGE: gone from list, staff, availability and POST — kept for agenda and bot', async () => {
  const fx = await mkSite();
  await query(`UPDATE services SET public_visible = false WHERE id = $1`, [fx.hiddenId]);

  const list = (await (await get('services', fx.slug)).json()) as { services: Array<{ id: string }> };
  assert.deepEqual(list.services.map((s) => s.id), [fx.serviceId]);
  const staff = (await (await get('staff', fx.slug, `?service_id=${fx.hiddenId}`)).json()) as { staff: unknown[] };
  assert.equal(staff.staff.length, 0);
  const visibleStaff = (await (await get('staff', fx.slug, `?service_id=${fx.serviceId}`)).json()) as { staff: Array<{ service_ids: string[] }> };
  assert.deepEqual(visibleStaff.staff[0].service_ids, [fx.serviceId], '"Servicios que realiza" lists only page services');
  assert.equal((await get('availability', fx.slug, `?service_id=${fx.hiddenId}${window14()}`)).status, 409);

  const res = await post(fx.slug, booking(fx, { service_id: fx.hiddenId }));
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'service_unavailable');
  assert.equal(await countAppts(fx), 0);

  // The agenda and the bot still see it: page visibility is presentation only.
  assert.ok((await listServicesForSite(fx.tenantId, fx.siteId)).some((s) => s.id === fx.hiddenId));
  assert.ok((await listBookableServicesForSite(fx.tenantId, fx.siteId)).some((s) => s.id === fx.hiddenId));
});

test('a WhatsApp-only group and a hidden group take their services off the page; categories travel in order', async () => {
  const fx = await mkSite();
  const color = await createBookingCategory(fx.tenantId, fx.clientId, { name: 'Color', tagline: '¿Buscas color?', layout: 'contact', sortOrder: 9, visible: true });
  const esencial = await createBookingCategory(fx.tenantId, fx.clientId, { name: 'Esencial', tagline: 'Impecable y a tiempo', layout: 'list', sortOrder: 1, visible: true });
  const base = { visible: true, sort: 0, recommended: false, includes: null, upgradeServiceId: null };
  assert.equal(await updateServicePresentation(fx.tenantId, fx.clientId, fx.hiddenId, { ...base, categoryId: color }), true);
  assert.equal(await updateServicePresentation(fx.tenantId, fx.clientId, fx.serviceId, { ...base, categoryId: esencial, recommended: true, includes: ['Lavado'], upgradeServiceId: fx.hiddenId }), true);

  const d = (await (await get('services', fx.slug)).json()) as {
    services: Array<{ id: string; category_id: string | null; recommended: boolean; includes: string[]; upgrade_to: string | null }>;
    categories: Array<{ name: string; layout: string }>;
  };
  assert.deepEqual(d.services.map((s) => s.id), [fx.serviceId], 'the colour service is only a WhatsApp link');
  assert.deepEqual(d.categories.map((c) => [c.name, c.layout]), [['Esencial', 'list'], ['Color', 'contact']]);
  assert.equal(d.services[0].category_id, esencial);
  assert.equal(d.services[0].recommended, true);
  assert.deepEqual(d.services[0].includes, ['Lavado']);
  assert.equal(((await post(fx.slug, booking(fx, { service_id: fx.hiddenId }))).status), 409);

  await query(`UPDATE booking_categories SET visible = false WHERE id = $1`, [esencial]);
  const after = (await (await get('services', fx.slug)).json()) as { services: unknown[]; categories: Array<{ name: string }> };
  assert.equal(after.services.length, 0, 'a hidden group hides its services from the page');
  assert.deepEqual(after.categories.map((c) => c.name), ['Color']);
  assert.ok((await listServicesForSite(fx.tenantId, fx.siteId)).length === 2, 'the agenda is unaffected');
});

test('isolation: another client’s category or service can never be attached', async () => {
  const a = await mkSite();
  const b = await mkSite();
  const foreignCat = await createBookingCategory(b.tenantId, b.clientId, { name: 'Ajena', tagline: null, layout: 'list', sortOrder: 0, visible: true });
  const base = { visible: true, sort: 0, recommended: false, includes: null };
  assert.equal(await updateServicePresentation(a.tenantId, a.clientId, a.serviceId, { ...base, categoryId: foreignCat, upgradeServiceId: null }), false);
  assert.equal(await updateServicePresentation(a.tenantId, a.clientId, a.serviceId, { ...base, categoryId: null, upgradeServiceId: b.serviceId }), false);
  assert.equal(await updateServicePresentation(a.tenantId, a.clientId, b.serviceId, { ...base, categoryId: null, upgradeServiceId: null }), false, 'nor edit its services');
  assert.equal(await updateServicePresentation(a.tenantId, a.clientId, a.serviceId, { ...base, categoryId: null, upgradeServiceId: a.serviceId }), false, 'not its own alternative');
  const row = (await query(`SELECT public_category_id, public_upgrade_service_id FROM services WHERE id = $1`, [a.serviceId])).rows[0];
  assert.deepEqual(row, { public_category_id: null, public_upgrade_service_id: null }, 'nothing was written');
});

test('price guard: a price changed after it was shown is refused (current price, zero writes); the shown price books', async () => {
  const fx = await mkSite();
  const stale = await post(fx.slug, booking(fx, { expected_price: '55000.00', staff_id: fx.staffId }));
  assert.equal(stale.status, 409);
  const e = ((await stale.json()) as { error: { code: string; price: string | null } }).error;
  assert.equal(e.code, 'price_changed');
  assert.equal(Number(e.price), 60000);
  assert.equal(await countAppts(fx), 0, 'nothing was booked');

  const ok = await post(fx.slug, booking(fx, { expected_price: '60000', staff_id: fx.staffId }));
  assert.equal(ok.status, 201);
  assert.equal(Number(((await ok.json()) as { confirmation: { price: string } }).confirmation.price), 60000);

  // Without expected_price (older pages, "Desde …"), nothing is compared.
  const legacy = await post(fx.slug, booking(fx, { start_at: at(12).toISOString() }));
  assert.equal(legacy.status, 201);
  // A malformed value is rejected by the strict body, never coerced.
  assert.equal((await post(fx.slug, booking(fx, { start_at: at(14).toISOString(), expected_price: '60.000' }))).status, 422);
});

test('the business rating counts every approved review of the site, not one artist’s or service’s', async () => {
  const fx = await mkSite();
  assert.equal(await publicSiteRating(fx.tenantId, fx.siteId), null, 'no reviews → nothing (never a placeholder)');
  const mkCompleted = async (h: number) => {
    const r = await query<{ id: string }>(
      `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
                                 service_name_snapshot, duration_min_snapshot, price_snapshot, status, origin, created_by_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7, 'Corte', 60, 60000, 'completed', 'internal', 'agent') RETURNING id`,
      [fx.tenantId, fx.clientId, fx.siteId, fx.staffId, fx.serviceId, at(h), at(h + 1)],
    );
    return r.rows[0].id;
  };
  for (const [h, rating, status] of [[9, 5, 'approved'], [11, 4, 'approved'], [13, 1, 'hidden']] as const) {
    const appt = await mkCompleted(h);
    await query(
      `INSERT INTO appointment_reviews (tenant_id, client_id, site_id, appointment_id, staff_id, service_id, service_name, status, rating, author_display, publish_consent, submitted_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'Corte', $7, $8, 'Cliente S.', true, now(), now() + interval '30 days')`,
      [fx.tenantId, fx.clientId, fx.siteId, appt, fx.staffId, fx.serviceId, status, rating],
    );
  }
  assert.deepEqual(await publicSiteRating(fx.tenantId, fx.siteId), { average: 4.5, count: 2, imported: 0 }, 'only approved ones');
});
