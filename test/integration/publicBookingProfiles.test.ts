import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { updateStaff } from '../../src/db/repositories/scheduling/staff.js';
import { OPEN_9_18, cleanupTenant, closeDb } from './fixtures.js';

/**
 * PUBLIC PROFILES of professionals on /book/{slug} (migration 1800 + the staff endpoint),
 * through the real route handlers and PostgreSQL. What a visitor may see: name, public
 * title, presentation, photo (https), the public services they perform — and nothing
 * else: no internal role, no contact field, nobody who does not take bookings, nothing
 * from another site or business.
 */

type Handler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
const staffRoute = async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/staff/route.js')).GET;
const servicesRoute = async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/services/route.js')).GET;

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const BIO = 'Barbero profesional enfocado en encontrar un estilo que refleje tu personalidad.';

async function mkSite(name = 'Sede Centro') {
  const tenantId = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [tenantId, `T ${tenantId.slice(0, 8)}`]);
  tenants.push(tenantId);
  const c = await query<{ id: string }>(`INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, 'Biz', false) RETURNING id`, [tenantId]);
  const clientId = c.rows[0].id;
  const slug = `prof-${randomUUID().slice(0, 10)}`;
  const s = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, address, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, $4, 'Calle 1', 'America/Bogota', $5,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":45,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, name, JSON.stringify(OPEN_9_18)],
  );
  const siteId = s.rows[0].id;
  const mkService = async (n: string, atSite = true) => {
    const r = await query<{ id: string }>(
      `INSERT INTO services (tenant_id, client_id, name, duration_min, price) VALUES ($1, $2, $3, 60, 50000) RETURNING id`,
      [tenantId, clientId, n],
    );
    if (atSite) await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, r.rows[0].id]);
    return r.rows[0].id;
  };
  const cut = await mkService('Corte');
  const beard = await mkService('Barba');
  const offSite = await mkService('No ofrecido aquí', false);
  const mkStaff = async (n: string, opts: { takes?: boolean; active?: boolean } = {}) => {
    const r = await query<{ id: string }>(
      `INSERT INTO staff (tenant_id, site_id, name, working_hours, takes_bookings, active, title, phone, email, emergency_contact_name, emergency_contact_phone,
                          public_title, public_bio)
         VALUES ($1, $2, $3, '{}'::jsonb, $4, $5, 'Rol-interno-secreto', '+573009998877', 'empleado.privado@example.com', 'Contacto Emergencia', '+573001110000',
                 'Barbero profesional', $6)
       RETURNING id`,
      [tenantId, siteId, n, opts.takes ?? true, opts.active ?? true, BIO],
    );
    for (const sv of [cut, beard, offSite]) {
      await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, r.rows[0].id, sv]);
    }
    return r.rows[0].id;
  };
  const ana = await mkStaff('Ana');
  const desk = await mkStaff('Recepción', { takes: false });
  const gone = await mkStaff('Exempleado', { active: false });
  await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  return { tenantId, clientId, siteId, slug, cut, beard, offSite, ana, desk, gone };
}

const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.7`;
async function getStaff(slug: string, serviceId: string): Promise<Response> {
  return (await staffRoute())(new Request(`http://localhost/api/booking/${slug}/staff?service_id=${serviceId}`, { headers: { 'x-forwarded-for': ip() } }), ctx(slug));
}

test('the staff endpoint returns the PUBLIC profile and the public services each artist performs', async () => {
  const site = await mkSite();
  await updateStaff(site.tenantId, site.ana, { publicPhotoUrl: 'https://cdn.example.com/staff/ana.jpg' });
  const res = await getStaff(site.slug, site.cut);
  assert.equal(res.status, 200);
  const d = (await res.json()) as { staff: Array<Record<string, unknown>> };
  assert.deepEqual(d.staff.map((s) => s.name), ['Ana'], 'only active staff who take bookings');
  const ana = d.staff[0];
  assert.equal(ana.title, 'Barbero profesional');
  assert.equal(ana.bio, BIO);
  assert.equal(ana.photo_url, 'https://cdn.example.com/staff/ana.jpg');
  assert.deepEqual([...(ana.service_ids as string[])].sort(), [site.cut, site.beard].sort(), 'never a service the site does not offer');
  assert.deepEqual(Object.keys(ana).sort(), ['bio', 'duration_min', 'id', 'name', 'photo_url', 'price', 'rating', 'reviews', 'service_ids', 'title']);
});

test('no internal role, contact field, inactive or no-chair professional ever leaks', async () => {
  const site = await mkSite();
  const text = await (await getStaff(site.slug, site.cut)).text();
  for (const f of ['Rol-interno-secreto', '+573009998877', 'empleado.privado@example.com', 'Contacto Emergencia', '+573001110000', 'Recepción', 'Exempleado', site.desk, site.gone, site.tenantId, site.clientId, site.siteId, 'phone', 'email', 'emergency', 'tenant', 'client_id']) {
    assert.ok(!text.includes(f), `must not contain ${f}`);
  }
});

test('a profile is unpublished when blank; the database refuses non-https photos and oversized text', async () => {
  const site = await mkSite();
  await updateStaff(site.tenantId, site.ana, { publicBio: '   ', publicTitle: '' });
  const d = (await (await getStaff(site.slug, site.cut)).json()) as { staff: Array<{ bio: string | null; title: string | null; photo_url: string | null }> };
  assert.deepEqual([d.staff[0].bio, d.staff[0].title, d.staff[0].photo_url], [null, null, null]);
  await assert.rejects(query(`UPDATE staff SET public_photo_url = 'http://insecure.example.com/x.jpg' WHERE id = $1`, [site.ana]), /staff_public_photo_url_check/);
  await assert.rejects(query(`UPDATE staff SET public_photo_url = 'javascript:alert(1)' WHERE id = $1`, [site.ana]), /staff_public_photo_url_check/);
  await assert.rejects(query(`UPDATE staff SET public_bio = $2 WHERE id = $1`, [site.ana, 'a'.repeat(601)]), /staff_public_bio_check/);
  await assert.rejects(query(`UPDATE staff SET public_title = $2 WHERE id = $1`, [site.ana, 't'.repeat(61)]), /staff_public_title_check/);
});

test('isolation: a slug never answers with another business or site\'s professionals', async () => {
  const a = await mkSite('Sede A');
  const b = await mkSite('Sede B');
  await updateStaff(b.tenantId, b.ana, { publicBio: 'Presentación exclusiva de la otra empresa.' });
  // B's service id asked through A's slug: nothing.
  const cross = (await (await getStaff(a.slug, b.cut)).json()) as { staff: unknown[] };
  assert.deepEqual(cross.staff, []);
  const own = await (await getStaff(a.slug, a.cut)).text();
  assert.ok(!own.includes(b.ana) && !own.includes('otra empresa'));
});

test('the services endpoint publishes the booking horizon (a rule), not internal settings', async () => {
  const site = await mkSite();
  const res = await (await servicesRoute())(new Request(`http://localhost/api/booking/${site.slug}/services`, { headers: { 'x-forwarded-for': ip() } }), ctx(site.slug));
  const d = (await res.json()) as { site: Record<string, unknown> };
  assert.equal(d.site.booking_horizon_days, 45);
  assert.deepEqual(Object.keys(d.site).sort(), ['address', 'booking_horizon_days', 'closed_weekdays', 'name', 'timezone']);
});
