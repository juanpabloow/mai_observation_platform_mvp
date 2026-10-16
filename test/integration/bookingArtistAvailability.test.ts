import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { listPublicServicesForSite } from '../../src/db/repositories/scheduling/publicCatalog.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { servicePageDiagnosis } from '../../web/lib/bookingPage.js';
import { OPEN_9_18, cleanupTenant, closeDb } from './fixtures.js';

/**
 * AVAILABILITY BY ARTIST through the PUBLIC routes, against the real engine and database.
 *   - Falla away, Federico working: Falla's days say so; Federico and "Sin preferencia"
 *     find Federico's real times; the site is never "closed" because of Falla.
 *   - one artist away and the other not enabled for the service;
 *   - everyone away with the site open; the site itself closed (weekday + site block);
 *   - breaks/blocks that leave gaps too short for the service, and two artists' gaps that
 *     must never be stitched into one slot; services with different durations;
 *   - /next-available: the real first day per artist;
 *   - the private block text never reaches the public payload;
 *   - the "¿aparece en la página?" diagnosis agrees with the real catalogue query.
 */

const TZ = 'America/Bogota';
type Handler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
const route = {
  availability: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/availability/route.js')).GET,
  next: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/next-available/route.js')).GET,
};
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

function futureDay(isoWeekday: number, weeksAhead = 3): { y: number; m: number; d: number } {
  const names = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const base = new Date(Date.now() + weeksAhead * 7 * 86_400_000);
  for (let i = 0; i < 7; i++) {
    const day = new Date(base.getTime() + i * 86_400_000);
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(day);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    if (get('weekday') === names[isoWeekday]) return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')) };
  }
  throw new Error('no day');
}
const WED = futureDay(3);
const SUN = futureDay(7);
const at = (day: { y: number; m: number; d: number }, h: number, min = 0) => zonedPartsToUtc(day.y, day.m, day.d, h, min, TZ);
const key = (day: { y: number; m: number; d: number }) => `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`;
const hhmm = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

async function mkSite() {
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `T ${tenantId.slice(0, 8)}`]);
  tenants.push(tenantId);
  const c = await query<{ id: string }>(`INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, false) RETURNING id`, [tenantId, `Biz ${randomUUID().slice(0, 6)}`]);
  const clientId = c.rows[0].id;
  const slug = `avail-${randomUUID().slice(0, 10)}`;
  const s = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Sede', $4, $5, '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, TZ, JSON.stringify(OPEN_9_18)],
  );
  const siteId = s.rows[0].id;
  const mkService = async (name: string, minutes: number) => {
    const r = await query<{ id: string }>(`INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, $3, $4, 60000) RETURNING id`, [tenantId, clientId, name, minutes]);
    await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, r.rows[0].id]);
    return r.rows[0].id;
  };
  const svc60 = await mkService('Corte', 60);
  const svc30 = await mkService('Barba', 30);
  const svc90 = await mkService('Ritual', 90);
  const svcSig = await mkService('Corte Signature', 60);
  const mkStaff = async (name: string, services: string[]) => {
    const r = await query<{ id: string }>(`INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, $3, '{}'::jsonb) RETURNING id`, [tenantId, siteId, name]);
    for (const sv of services) await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, r.rows[0].id, sv]);
    return r.rows[0].id;
  };
  const falla = await mkStaff('Falla', [svc60, svc30, svc90]);
  const fede = await mkStaff('Federico', [svc60, svc30, svc90, svcSig]);
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  return { tenantId, clientId, siteId, slug, svc60, svc30, svc90, svcSig, falla, fede };
}
type Fx = Awaited<ReturnType<typeof mkSite>>;

async function block(fx: Fx, staffId: string | null, from: Date, until: Date, publicReason: string | null = null, reason = 'Motivo interno privado: cita médica de Falla') {
  await query(
    `INSERT INTO schedule_exceptions (tenant_id, site_id, staff_id, starts_at, ends_at, reason, public_reason) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [fx.tenantId, fx.siteId, staffId, from, until, reason, publicReason],
  );
}

interface AvailBody {
  slots: Array<{ start_at: string; staff_id: string; available_staff_ids: string[] }>;
  days?: Array<{ date: string; kind: string; reason: string | null }>;
}
async function availability(fx: Fx, service: string, staff: string | null, day = WED): Promise<{ raw: string; body: AvailBody }> {
  const q = new URLSearchParams({ service_id: service, from: at(day, 0).toISOString(), to: new Date(at(day, 0).getTime() + 86_400_000).toISOString(), explain: '1' });
  if (staff) q.set('staff_id', staff);
  const res = await (await route.availability())(new Request(`http://localhost/api/booking/${fx.slug}/availability?${q}`, { headers: { 'x-forwarded-for': `10.7.${Math.floor(Math.random() * 250)}.1` } }), { params: Promise.resolve({ slug: fx.slug }) });
  assert.equal(res.status, 200);
  const raw = await res.text();
  return { raw, body: JSON.parse(raw) as AvailBody };
}
const dayKind = (b: AvailBody) => b.days?.map((d) => [d.kind, d.reason]);

test('Falla on vacation, Federico working: Falla is away (never "site closed"); Federico and Sin preferencia find his real times', async () => {
  const fx = await mkSite();
  await block(fx, fx.falla, at(WED, 0), new Date(at(WED, 0).getTime() + 86_400_000), 'vacation');

  const falla = await availability(fx, fx.svc60, fx.falla);
  assert.equal(falla.body.slots.length, 0);
  assert.deepEqual(dayKind(falla.body), [['artist_unavailable', 'vacation']]);
  assert.equal(falla.raw.includes('privado'), false, 'the internal block text never leaves');

  const fede = await availability(fx, fx.svc60, fx.fede);
  assert.equal(fede.body.slots.length, 17, '09:00 … 17:00, every 30 min (each holds the full 60 min)');
  assert.deepEqual(dayKind(fede.body), [['open', null]]);

  const any = await availability(fx, fx.svc60, null);
  assert.deepEqual(dayKind(any.body), [['open', null]]);
  assert.ok(any.body.slots.every((s) => s.staff_id === fx.fede && !s.available_staff_ids.includes(fx.falla)), 'only Federico is offered');
});

test('one artist away + the other not enabled for the service: no times, but the site is open', async () => {
  const fx = await mkSite();
  await block(fx, fx.fede, at(WED, 0), new Date(at(WED, 0).getTime() + 86_400_000), null);
  const any = await availability(fx, fx.svcSig, null);
  assert.equal(any.body.slots.length, 0);
  assert.deepEqual(dayKind(any.body), [['no_slots', null]], 'Falla does not perform it; Federico is away — not "closed"');
  const fede = await availability(fx, fx.svcSig, fx.fede);
  assert.deepEqual(dayKind(fede.body), [['artist_unavailable', null]], 'no published reason → neutral');
  const fallaForSig = await availability(fx, fx.svcSig, fx.falla);
  assert.equal(fallaForSig.body.slots.length, 0, 'an artist who does not perform it never gets times');
});

test('everyone away with the site open → "no times left"; the site closed (weekday or site block) → "site closed"', async () => {
  const fx = await mkSite();
  const end = new Date(at(WED, 0).getTime() + 86_400_000);
  await block(fx, fx.falla, at(WED, 0), end, 'vacation');
  await block(fx, fx.fede, at(WED, 0), end, 'unavailable');
  assert.deepEqual(dayKind((await availability(fx, fx.svc60, null)).body), [['no_slots', null]]);
  assert.deepEqual(dayKind((await availability(fx, fx.svc60, fx.fede)).body), [['artist_unavailable', 'unavailable']]);

  assert.deepEqual(dayKind((await availability(fx, fx.svc60, null, SUN)).body), [['site_closed', null]], 'Sunday: the site never opens');

  const fx2 = await mkSite();
  await block(fx2, null, at(WED, 0), new Date(at(WED, 0).getTime() + 86_400_000), 'site_closed', 'Fumigación');
  for (const staff of [null, fx2.falla]) {
    const r = await availability(fx2, fx2.svc60, staff);
    assert.deepEqual(dayKind(r.body), [['site_closed', 'site_closed']]);
    assert.equal(r.raw.includes('Fumigación'), false);
  }
});

test('breaks and blocks: only gaps that hold the WHOLE service; two artists’ gaps are never stitched', async () => {
  const fx = await mkSite();
  // Falla: free 09:00–10:00 only. Federico: free 10:00–11:00 only.
  await block(fx, fx.falla, at(WED, 10), at(WED, 18));
  await block(fx, fx.fede, at(WED, 9), at(WED, 10));
  await block(fx, fx.fede, at(WED, 11), at(WED, 18));

  const s60 = (await availability(fx, fx.svc60, null)).body.slots;
  assert.deepEqual(s60.map((s) => [hhmm(s.start_at), s.staff_id === fx.falla ? 'Falla' : 'Federico']), [['09:00', 'Falla'], ['10:00', 'Federico']]);
  const s90 = await availability(fx, fx.svc90, null);
  assert.equal(s90.body.slots.length, 0, '09:00–10:30 would need Falla AND Federico: never offered');
  assert.deepEqual(dayKind(s90.body), [['no_slots', null]]);
  const s30 = (await availability(fx, fx.svc30, null)).body.slots.map((s) => hhmm(s.start_at));
  assert.deepEqual(s30, ['09:00', '09:30', '10:00', '10:30'], 'a shorter service fits where a longer one does not');
  // A break inside one artist's day: a 60-min service can't start at 09:30 if 10:00–10:30 is blocked.
  const fx2 = await mkSite();
  await block(fx2, fx2.fede, at(WED, 10), at(WED, 10, 30));
  const fede60 = (await availability(fx2, fx2.svc60, fx2.fede)).body.slots.map((s) => hhmm(s.start_at));
  assert.ok(fede60.includes('09:00') && !fede60.includes('09:30') && !fede60.includes('10:00') && fede60.includes('10:30'));
});

test('/next-available: the real first day for the chosen artist and for each other one', async () => {
  const fx = await mkSite();
  await block(fx, fx.falla, at(WED, 0), new Date(at(WED, 0).getTime() + 7 * 86_400_000), 'vacation');
  // Falla is also away until the vacation starts, so her first day is after it.
  await block(fx, fx.falla, new Date(Date.now() - 3_600_000), at(WED, 0), null);
  const q = new URLSearchParams({ service_id: fx.svc60, staff_id: fx.falla });
  const res = await (await route.next())(new Request(`http://localhost/api/booking/${fx.slug}/next-available?${q}`, { headers: { 'x-forwarded-for': '10.8.0.1' } }), { params: Promise.resolve({ slug: fx.slug }) });
  assert.equal(res.status, 200);
  const d = (await res.json()) as { artist: string | null; any: string | null; others: Array<{ name: string; first_day: string | null }> };
  const nextWed = new Date(at(WED, 12).getTime() + 7 * 86_400_000);
  const nextWedKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(nextWed);
  assert.equal(d.artist, nextWedKey, 'the first day after her absence');
  assert.ok(d.any && d.any < key(WED), 'Federico works before that');
  assert.deepEqual(d.others.map((o) => o.name), ['Federico']);
  assert.ok(d.others[0].first_day && d.others[0].first_day <= key(WED));
});

test('diagnosis agrees with the real catalogue query (listed ⇔ diagnosed visible)', async () => {
  const fx = await mkSite();
  const listed = async (id: string) => (await listPublicServicesForSite(fx.tenantId, fx.siteId)).some((s) => s.id === id);
  const diag = async (id: string) => {
    const svc = (await query(`SELECT active, public_visible, description, public_includes, public_image_url, price, duration_min FROM services WHERE id = $1`, [id])).rows[0];
    const staff = (await query<{ name: string; active: boolean; takes_bookings: boolean; performs: boolean }>(
      `SELECT st.name, st.active, st.takes_bookings, EXISTS (SELECT 1 FROM staff_services ss WHERE ss.staff_id = st.id AND ss.service_id = $1 AND ss.active) AS performs
         FROM staff st WHERE st.site_id = $2`,
      [id, fx.siteId],
    )).rows;
    const enabled = (await query(`SELECT 1 FROM site_services WHERE site_id = $1 AND service_id = $2 AND active`, [fx.siteId, id])).rows.length > 0;
    return servicePageDiagnosis({
      service: { active: svc.active, visible: svc.public_visible, description: svc.description, includes: svc.public_includes ?? [], imageUrl: svc.public_image_url, price: svc.price, durationMin: svc.duration_min },
      category: null,
      sites: [{ id: fx.siteId, name: 'Sede', active: true, enabled, artists: staff.map((a) => ({ name: a.name, active: a.active, takesBookings: a.takes_bookings, performs: a.performs })) }],
    }).status;
  };
  const check = async (id: string, expected: boolean, why: string) => {
    assert.equal(await listed(id), expected, `listed: ${why}`);
    assert.equal((await diag(id)) === 'visible', expected, `diagnosis: ${why}`);
  };
  await check(fx.svcSig, true, 'Federico performs it');
  await query(`UPDATE staff SET takes_bookings = false WHERE id = $1`, [fx.fede]);
  await check(fx.svcSig, false, 'its only artist does not take bookings');
  await query(`UPDATE staff SET takes_bookings = true WHERE id = $1`, [fx.fede]);
  await query(`UPDATE staff_services SET active = false WHERE service_id = $1`, [fx.svcSig]);
  await check(fx.svcSig, false, 'nobody performs it');
  await check(fx.svc60, true, 'two artists perform it');
  await query(`UPDATE site_services SET active = false WHERE service_id = $1`, [fx.svc60]);
  await check(fx.svc60, false, 'not enabled at the site');
  await query(`UPDATE services SET public_visible = false WHERE id = $1`, [fx.svc30]);
  await check(fx.svc30, false, 'hidden on the page');
});
