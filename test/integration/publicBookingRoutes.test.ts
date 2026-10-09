import { randomUUID, createHmac } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, afterEach, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { OPEN_9_18, cleanupTenant, closeDb } from './fixtures.js';

/**
 * The PUBLIC booking ROUTE HANDLERS, invoked as Next imports them (Request + params) —
 * no session, no cookies, exactly like a visitor from Instagram. They run against the
 * real PostgreSQL test database, so the gate, the engine, the exclusion constraint, the
 * Idempotency-Key replay, the per-phone cap, the persistent rate limit and Turnstile
 * are all exercised end to end through the HTTP adapter.
 *
 * Not covered here: Next's routing/middleware (a URL reaching these files) — the
 * middleware's PUBLIC_PREFIXES contract is a unit test (publicBookingContract.test.ts).
 */

const TZ = 'America/Bogota';

type Handler = (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response>;
const routes = {
  post: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/route.js')).POST,
  services: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/services/route.js')).GET,
  staff: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/staff/route.js')).GET,
  availability: async (): Promise<Handler> => (await import('../../web/app/api/booking/[slug]/availability/route.js')).GET,
};

// ── Environment: every test starts from the same known policy ────────────────────
const POLICY_ENV = [
  'PUBLIC_BOOKING_DISABLED',
  'PUBLIC_BOOKING_RATE_LIMIT_IP_MAX',
  'PUBLIC_BOOKING_RATE_LIMIT_IP_WINDOW_SECONDS',
  'PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX',
  'PUBLIC_BOOKING_RATE_LIMIT_PHONE_WINDOW_SECONDS',
  'PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE',
  'PUBLIC_BOOKING_HASH_SECRET',
  'PUBLIC_BOOKING_TURNSTILE_ENABLED',
  'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
  'PUBLIC_BOOKING_TURNSTILE_SECRET_KEY',
] as const;
const savedEnv = Object.fromEntries(POLICY_ENV.map((k) => [k, process.env[k]]));
const HASH_SECRET = 'test-public-booking-hash-secret-0123456789';
function resetEnv(): void {
  for (const k of POLICY_ENV) delete process.env[k];
  process.env.PUBLIC_BOOKING_HASH_SECRET = HASH_SECRET;
}
resetEnv();

const realFetch = globalThis.fetch;
afterEach(() => {
  resetEnv();
  globalThis.fetch = realFetch;
});

const tenants: string[] = [];
after(async () => {
  for (const k of POLICY_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

// ── Fixtures ─────────────────────────────────────────────────────────────────────

/** A Bogotá day well in the future that the 9–18 Mon–Sat fixture opens (a Wednesday),
 * so the real `now` the routes use never makes these slots past. */
function futureWednesday(weeksAhead = 3): { y: number; m: number; d: number } {
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
const at = (h: number, min = 0, day = WED): Date => zonedPartsToUtc(day.y, day.m, day.d, h, min, TZ);

async function mkTenant(): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [id, `T ${id.slice(0, 8)}`]);
  tenants.push(id);
  return id;
}

interface Site {
  tenantId: string;
  clientId: string;
  siteId: string;
  slug: string;
  serviceId: string;
  staffId: string;
  staff2Id: string;
}

/** A bookable site: non-default client with scheduling ON, one 60-min priced service,
 * two professionals who perform it (both carrying PII that must never leak). */
async function mkSite(tenantId: string, opts: { isDefault?: boolean; enable?: boolean } = {}): Promise<Site> {
  const c = await query<{ id: string }>(
    `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, `Biz ${randomUUID().slice(0, 6)}`, opts.isDefault ?? false],
  );
  const clientId = c.rows[0].id;
  const slug = `pub-${randomUUID().slice(0, 10)}`;
  const s = await query<{ id: string }>(
    `INSERT INTO sites (tenant_id, client_id, slug, name, address, timezone, opening_hours, scheduling_config)
       VALUES ($1, $2, $3, 'Sede Centro', 'Calle 1 # 2-3', $4, $5,
         '{"slot_interval_min":30,"min_notice_min":0,"booking_horizon_days":365,"default_buffer_before_min":0,"default_buffer_after_min":0}'::jsonb)
     RETURNING id`,
    [tenantId, clientId, slug, TZ, JSON.stringify(OPEN_9_18)],
  );
  const siteId = s.rows[0].id;
  const svc = await query<{ id: string }>(
    `INSERT INTO services (tenant_id, client_id, name, description, duration_min, price, buffer_before_min)
       VALUES ($1, $2, 'Corte clásico', 'Corte con tijera', 60, 45000, 0) RETURNING id`,
    [tenantId, clientId],
  );
  const serviceId = svc.rows[0].id;
  await query(`INSERT INTO site_services (tenant_id, site_id, service_id) VALUES ($1, $2, $3)`, [tenantId, siteId, serviceId]);
  const mkStaff = async (name: string) => {
    const r = await query<{ id: string }>(
      `INSERT INTO staff (tenant_id, site_id, name, working_hours, phone, email, emergency_contact_name, emergency_contact_phone)
         VALUES ($1, $2, $3, '{}'::jsonb, '+573009998877', 'empleado.privado@example.com', 'Contacto Emergencia', '+573001110000')
       RETURNING id`,
      [tenantId, siteId, name],
    );
    await query(`INSERT INTO staff_services (tenant_id, staff_id, service_id) VALUES ($1, $2, $3)`, [tenantId, r.rows[0].id, serviceId]);
    return r.rows[0].id;
  };
  const staffId = await mkStaff('Ana Ruiz');
  const staff2Id = await mkStaff('Beto Díaz');
  if (opts.enable ?? true) await setClientModuleEnabled({ tenantId, clientId, moduleKey: 'scheduling', enabled: true });
  return { tenantId, clientId, siteId, slug, serviceId, staffId, staff2Id };
}

const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function get(kind: 'services' | 'staff' | 'availability', slug: string, qs = '', ip = randomIp()): Promise<Response> {
  const h = await routes[kind]();
  const path = kind === 'services' ? 'services' : kind;
  return h(new Request(`http://localhost/api/booking/${slug}/${path}${qs}`, { headers: { 'x-forwarded-for': ip } }), ctx(slug));
}

let phoneSeq = 0;
/** A distinct local Colombian mobile per call, so tests don't share a phone quota. */
const freshPhone = () => `30${String(10_000_000 + ((Date.now() + phoneSeq++ * 7919) % 89_999_999)).padStart(8, '0')}`;

function body(site: Site, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    service_id: site.serviceId,
    start_at: at(10).toISOString(),
    customer_name: 'Lucía Ferrer',
    customer_phone: freshPhone(),
    privacy_accepted: true,
    ...over,
  };
}

async function post(slug: string, payload: unknown, opts: { ip?: string; key?: string | null } = {}): Promise<Response> {
  const h = await routes.post();
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-forwarded-for': opts.ip ?? randomIp() };
  if (opts.key !== null) headers['idempotency-key'] = opts.key ?? randomUUID();
  return h(
    new Request(`http://localhost/api/booking/${slug}`, {
      method: 'POST',
      headers,
      body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    }),
    ctx(slug),
  );
}

async function appts(site: Site): Promise<Array<Record<string, unknown>>> {
  const r = await query(`SELECT * FROM appointments WHERE tenant_id = $1 AND site_id = $2 ORDER BY created_at`, [site.tenantId, site.siteId]);
  return r.rows;
}

// ── 1. Public, unauthenticated, generic 404 ──────────────────────────────────────

test('a public site answers with NO session or cookie, with no-store + nosniff headers', async () => {
  const site = await mkSite(await mkTenant());
  const res = await get('services', site.slug);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  const d = (await res.json()) as { site: Record<string, unknown>; services: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(d.site).sort(), ['address', 'closed_weekdays', 'name', 'timezone']);
  assert.deepEqual(d.site.closed_weekdays, ['sun']);
  assert.equal(d.services.length, 1);
  assert.deepEqual(Object.keys(d.services[0]).sort(), ['description', 'duration_min', 'family', 'id', 'name', 'price']);
});

test('unknown / inactive / module-disabled / default-client / kill switch → the SAME 404 on every endpoint', async () => {
  const t = await mkTenant();
  const inactive = await mkSite(t);
  await query(`UPDATE sites SET active = false WHERE id = $1`, [inactive.siteId]);
  const disabled = await mkSite(t, { enable: false });
  const dflt = await mkSite(t, { isDefault: true }); // module force-enabled on the default client
  const live = await mkSite(t);

  const bodies = new Set<string>();
  const probe = async (slug: string) => {
    const svc = await get('services', slug);
    const stf = await get('staff', slug, `?service_id=${live.serviceId}`);
    const av = await get('availability', slug, '?service_id=not-a-uuid'); // invalid input must not leak past the gate
    const pst = await post(slug, '{not json');
    for (const r of [svc, stf, av, pst]) {
      assert.equal(r.status, 404, `${slug} → 404`);
      bodies.add(await r.text());
    }
  };
  await probe(`nope-${randomUUID().slice(0, 8)}`);
  await probe(inactive.slug);
  await probe(disabled.slug);
  await probe(dflt.slug);
  process.env.PUBLIC_BOOKING_DISABLED = 'true';
  await probe(live.slug);
  assert.equal(bodies.size, 1, 'one byte-identical body for every reason');
  assert.match([...bodies][0], /Esta página de reservas no está disponible/);
});

// ── 2. Resource relations ─────────────────────────────────────────────────────────

test('a service of ANOTHER site, a professional of another site, or one who does not perform the service → rejected, zero writes', async () => {
  const t = await mkTenant();
  const a = await mkSite(t);
  const b = await mkSite(t);
  // Ana at site A also exists at B? No — a third staff at A who does NOT perform the service.
  const lone = await query<{ id: string }>(
    `INSERT INTO staff (tenant_id, site_id, name, working_hours) VALUES ($1, $2, 'Sin servicio', '{}'::jsonb) RETURNING id`,
    [t, a.siteId],
  );

  const foreignService = await post(a.slug, body(a, { service_id: b.serviceId }));
  assert.equal(foreignService.status, 409);
  assert.equal(((await foreignService.json()) as { error: { code: string } }).error.code, 'service_unavailable');

  const foreignStaff = await post(a.slug, body(a, { staff_id: b.staffId }));
  assert.equal(foreignStaff.status, 409);

  const notQualified = await post(a.slug, body(a, { staff_id: lone.rows[0].id }));
  assert.equal(notQualified.status, 409);

  // Their staff lists agree: B's professionals and the unqualified one never appear at A.
  const staff = (await (await get('staff', a.slug, `?service_id=${a.serviceId}`)).json()) as { staff: Array<{ id: string }> };
  const ids = staff.staff.map((s) => s.id).sort();
  assert.deepEqual(ids, [a.staffId, a.staff2Id].sort());
  const foreignList = (await (await get('staff', a.slug, `?service_id=${b.serviceId}`)).json()) as { staff: unknown[] };
  assert.equal(foreignList.staff.length, 0);

  assert.equal((await appts(a)).length, 0);
  assert.equal((await appts(b)).length, 0);
});

test('a past start → 422 past_start, nothing written', async () => {
  const site = await mkSite(await mkTenant());
  const res = await post(site.slug, body(site, { start_at: new Date(Date.now() - 3600_000).toISOString() }));
  assert.equal(res.status, 422);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'past_start');
  assert.equal((await appts(site)).length, 0);
});

test('the client can NOT send tenant, client, price, duration, status, origin or created_by_type', async () => {
  const site = await mkSite(await mkTenant());
  for (const extra of [
    { tenant_id: randomUUID() },
    { client_id: randomUUID() },
    { price: 1 },
    { duration_min: 5 },
    { status: 'confirmed' },
    { origin: 'walk_in' },
    { created_by_type: 'agent' },
    { walk_in: true },
  ]) {
    const res = await post(site.slug, body(site, extra));
    assert.equal(res.status, 422, `${Object.keys(extra)[0]} is rejected`);
  }
  const noConsent = await post(site.slug, body(site, { privacy_accepted: false }));
  assert.equal(noConsent.status, 422, 'the data-processing checkbox is required server-side too');
  assert.equal((await appts(site)).length, 0);
});

// ── 3. Engine guarantees through the public adapter ──────────────────────────────

test('a booking is origin/created_by public (never walk-in) and snapshots name, price and duration', async () => {
  const site = await mkSite(await mkTenant());
  const res = await post(site.slug, body(site, { staff_id: site.staffId, customer_email: 'Lucia@Example.COM' }));
  assert.equal(res.status, 201);
  const { confirmation } = (await res.json()) as { confirmation: Record<string, unknown> };
  assert.deepEqual(
    Object.keys(confirmation).sort(),
    ['address', 'duration_min', 'price', 'reference', 'service', 'service_end_at', 'site', 'staff_name', 'start_at', 'timezone'],
  );
  assert.equal(confirmation.staff_name, 'Ana Ruiz');
  assert.equal(confirmation.service, 'Corte clásico');
  const [a] = await appts(site);
  assert.equal(a.origin, 'public');
  assert.equal(a.created_by_type, 'public');
  assert.equal(a.status, 'scheduled');
  assert.equal(a.service_name_snapshot, 'Corte clásico');
  assert.equal(Number(a.price_snapshot), 45000);
  assert.equal(a.duration_min_snapshot, 60);
  assert.equal(confirmation.reference, a.public_reference);
  assert.notEqual(confirmation.reference, a.id, 'the public reference is not the row id');
  assert.ok(String(a.idempotency_key).startsWith(`public:${site.siteId}:`), 'public keys are namespaced per site');
  const contact = await query<{ email: string | null }>(`SELECT email FROM contacts WHERE id = $1`, [a.contact_id]);
  assert.equal(contact.rows[0].email, 'lucia@example.com');
});

test('"Cualquier profesional" (no staff_id) lets the engine assign a professional', async () => {
  const site = await mkSite(await mkTenant());
  const res = await post(site.slug, body(site));
  assert.equal(res.status, 201);
  const [a] = await appts(site);
  assert.ok([site.staffId, site.staff2Id].includes(String(a.staff_id)));
});

test('an occupied slot → 409 slot_taken', async () => {
  const site = await mkSite(await mkTenant());
  assert.equal((await post(site.slug, body(site, { staff_id: site.staffId }))).status, 201);
  const second = await post(site.slug, body(site, { staff_id: site.staffId }));
  assert.equal(second.status, 409);
  assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'slot_taken');
  assert.equal((await appts(site)).length, 1);
});

test('two CONCURRENT bookings of the same professional and slot → exactly one is created', async () => {
  const site = await mkSite(await mkTenant());
  const results = await Promise.all(
    Array.from({ length: 5 }, () => post(site.slug, body(site, { staff_id: site.staffId, start_at: at(11).toISOString() }))),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.equal(statuses.filter((s) => s === 201).length, 1, `one winner, got ${statuses.join(',')}`);
  assert.ok(statuses.filter((s) => s !== 201).every((s) => s === 409));
  assert.equal((await appts(site)).length, 1);
});

test('a double submit with the SAME Idempotency-Key creates ONE appointment; a different payload conflicts', async () => {
  const site = await mkSite(await mkTenant());
  const key = randomUUID();
  const payload = body(site, { start_at: at(12).toISOString() });
  const [r1, r2] = await Promise.all([post(site.slug, payload, { key }), post(site.slug, payload, { key })]);
  const codes = [r1.status, r2.status].sort();
  assert.deepEqual(codes, [200, 201]);
  const refs = new Set([((await r1.json()) as { confirmation: { reference: string } }).confirmation.reference, ((await r2.json()) as { confirmation: { reference: string } }).confirmation.reference]);
  assert.equal(refs.size, 1, 'the replay returns the same booking');
  assert.equal((await appts(site)).length, 1);

  const other = await post(site.slug, { ...payload, start_at: at(14).toISOString() }, { key });
  assert.equal(other.status, 409);
  assert.equal(((await other.json()) as { error: { code: string } }).error.code, 'duplicate_request');
  assert.equal((await appts(site)).length, 1);
});

test('the contact is resolved by NORMALIZED phone — local, national and +57 forms are one person', async () => {
  const site = await mkSite(await mkTenant());
  const local = freshPhone();
  for (const [i, phone] of [local, `57${local}`, `+57 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`].entries()) {
    const res = await post(site.slug, body(site, { customer_phone: phone, start_at: at(9 + i * 2).toISOString() }));
    assert.equal(res.status, 201, `booking ${i}`);
  }
  const rows = await appts(site);
  assert.equal(new Set(rows.map((r) => r.contact_id)).size, 1, 'one contact');
  const c = await query<{ phone_e164: string }>(`SELECT phone_e164 FROM contacts WHERE id = $1`, [rows[0].contact_id]);
  assert.equal(c.rows[0].phone_e164, `+57${local}`);
});

test('a phone holds at most 3 FUTURE ACTIVE bookings per site; cancelled ones stop counting', async () => {
  const site = await mkSite(await mkTenant());
  process.env.PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX = '50';
  const phone = freshPhone();
  for (const h of [9, 11, 13]) {
    assert.equal((await post(site.slug, body(site, { customer_phone: phone, start_at: at(h).toISOString() }))).status, 201);
  }
  const fourth = await post(site.slug, body(site, { customer_phone: phone, start_at: at(15).toISOString() }));
  assert.equal(fourth.status, 409);
  const e = ((await fourth.json()) as { error: { code: string; message: string } }).error;
  assert.equal(e.code, 'active_limit');
  assert.ok(!/\d+ citas/.test(e.message), 'the message does not reveal the existing bookings');
  assert.equal((await appts(site)).length, 3, 'the refusal wrote nothing');

  // The same phone at ANOTHER site is unaffected (the cap is per site).
  const other = await mkSite(site.tenantId);
  assert.equal((await post(other.slug, body(other, { customer_phone: phone, start_at: at(15).toISOString() }))).status, 201);

  // Cancel one → room again. (completed / no_show leave the active set the same way.)
  const [first] = await appts(site);
  await query(`UPDATE appointments SET status = 'cancelled' WHERE id = $1`, [first.id]);
  assert.equal((await post(site.slug, body(site, { customer_phone: phone, start_at: at(15).toISOString() }))).status, 201);
});

test('concurrent bookings of one phone can not race past the cap', async () => {
  const site = await mkSite(await mkTenant());
  process.env.PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX = '50';
  process.env.PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE = '2';
  const phone = freshPhone();
  const results = await Promise.all(
    [9, 10, 11, 12, 13].map((h) => post(site.slug, body(site, { customer_phone: phone, start_at: at(h).toISOString() }))),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal((await appts(site)).length, 2);
});

// ── 4. Persistent rate limits ─────────────────────────────────────────────────────

test('rate limit by IP + site: the (N+1)th attempt from one IP → 429 with Retry-After; another site is separate', async () => {
  const t = await mkTenant();
  const site = await mkSite(t);
  const other = await mkSite(t);
  process.env.PUBLIC_BOOKING_RATE_LIMIT_IP_MAX = '3';
  const ip = randomIp();
  for (const h of [9, 11, 13]) {
    assert.equal((await post(site.slug, body(site, { start_at: at(h).toISOString() }), { ip })).status, 201);
  }
  const blocked = await post(site.slug, body(site, { start_at: at(15).toISOString() }), { ip });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await appts(site)).length, 3);
  assert.equal((await post(other.slug, body(other), { ip })).status, 201, 'the limit is per site');

  // Only HMACs are stored — never the IP.
  const rows = await query<{ key_hash: string; scope: string }>(
    `SELECT key_hash, scope FROM public_booking_rate_buckets WHERE tenant_id = $1 AND site_id = $2`,
    [t, site.siteId],
  );
  const ipRow = rows.rows.find((r) => r.scope === 'ip');
  assert.ok(ipRow);
  assert.equal(ipRow.key_hash, createHmac('sha256', HASH_SECRET).update(`ip\u0000${site.siteId}\u0000${ip}`).digest('hex'));
  assert.ok(!JSON.stringify(rows.rows).includes(ip));
});

test('rate limit by phone + site counts every normalized form of the number together', async () => {
  const site = await mkSite(await mkTenant());
  process.env.PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX = '2';
  const phone = freshPhone();
  // Both attempts conflict (same slot) — they still count.
  assert.equal((await post(site.slug, body(site, { customer_phone: phone, staff_id: site.staffId }))).status, 201);
  assert.equal((await post(site.slug, body(site, { customer_phone: `+57${phone}`, staff_id: site.staffId }))).status, 409);
  const third = await post(site.slug, body(site, { customer_phone: `57 ${phone}`, start_at: at(15).toISOString() }));
  assert.equal(third.status, 429);
  const stored = await query(`SELECT key_hash FROM public_booking_rate_buckets WHERE site_id = $1 AND scope = 'phone'`, [site.siteId]);
  assert.equal(stored.rows.length, 1, 'one bucket for all three spellings');
  assert.ok(!JSON.stringify(stored.rows).includes(phone), 'the phone is never stored in clear');
});

test('without a hashing secret, creation fails CLOSED (503) and writes nothing', async () => {
  const site = await mkSite(await mkTenant());
  delete process.env.PUBLIC_BOOKING_HASH_SECRET;
  const saved = process.env.BETTER_AUTH_SECRET;
  delete process.env.BETTER_AUTH_SECRET;
  try {
    const res = await post(site.slug, body(site));
    assert.equal(res.status, 503);
    assert.equal((await appts(site)).length, 0);
  } finally {
    if (saved !== undefined) process.env.BETTER_AUTH_SECRET = saved;
  }
});

// ── 5. Turnstile ──────────────────────────────────────────────────────────────────

function stubTurnstile(answer: Record<string, unknown> | 'throw'): { calls: URLSearchParams[] } {
  const calls: URLSearchParams[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes('challenges.cloudflare.com')) {
      calls.push(new URLSearchParams(String(init?.body ?? '')));
      if (answer === 'throw') throw new Error('network down');
      return Response.json(answer);
    }
    return realFetch(url, init);
  }) as typeof fetch;
  return { calls };
}

test('Turnstile is NOT consulted when disabled — no token needed', async () => {
  const site = await mkSite(await mkTenant());
  const stub = stubTurnstile({ success: false });
  assert.equal((await post(site.slug, body(site))).status, 201);
  assert.equal(stub.calls.length, 0);
});

test('Turnstile ENABLED: missing token → 403, invalid token → 403, both with zero appointments', async () => {
  const site = await mkSite(await mkTenant());
  process.env.PUBLIC_BOOKING_TURNSTILE_ENABLED = 'true';
  process.env.PUBLIC_BOOKING_TURNSTILE_SECRET_KEY = 'secret-test';
  const stub = stubTurnstile({ success: false, 'error-codes': ['invalid-input-response'] });
  const missing = await post(site.slug, body(site));
  assert.equal(missing.status, 403);
  assert.equal(stub.calls.length, 0, 'no token → refused before calling Cloudflare');
  const invalid = await post(site.slug, body(site, { turnstile_token: 'bad-token' }));
  assert.equal(invalid.status, 403);
  assert.equal(((await invalid.json()) as { error: { code: string } }).error.code, 'verification_failed');
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].get('secret'), 'secret-test');
  assert.equal(stub.calls[0].get('response'), 'bad-token');
  assert.equal((await appts(site)).length, 0);
});

test('Turnstile ENABLED: a token Cloudflare accepts books; the Idempotency-Key rides along for safe retries', async () => {
  const site = await mkSite(await mkTenant());
  process.env.PUBLIC_BOOKING_TURNSTILE_ENABLED = 'true';
  process.env.PUBLIC_BOOKING_TURNSTILE_SECRET_KEY = 'secret-test';
  const stub = stubTurnstile({ success: true, action: 'public_booking' });
  const key = randomUUID();
  assert.equal((await post(site.slug, body(site, { turnstile_token: 'good-token' }), { key })).status, 201);
  assert.equal(stub.calls[0].get('idempotency_key'), key);
  // A token minted for a different action of the same site key is refused.
  const otherAction = stubTurnstile({ success: true, action: 'login' });
  assert.equal((await post(site.slug, body(site, { turnstile_token: 'good-token', start_at: at(14).toISOString() }))).status, 403);
  assert.equal(otherAction.calls.length, 1);
  assert.equal((await appts(site)).length, 1);
});

test('Turnstile ENABLED but misconfigured (no secret) or unreachable → 503, fail closed', async () => {
  const site = await mkSite(await mkTenant());
  process.env.PUBLIC_BOOKING_TURNSTILE_ENABLED = 'true';
  stubTurnstile({ success: true });
  assert.equal((await post(site.slug, body(site, { turnstile_token: 'x' }))).status, 503, 'no secret');
  process.env.PUBLIC_BOOKING_TURNSTILE_SECRET_KEY = 'secret-test';
  stubTurnstile('throw');
  assert.equal((await post(site.slug, body(site, { turnstile_token: 'x' }))).status, 503, 'network error');
  assert.equal((await appts(site)).length, 0);
});

// ── 6. No PII / internals in any public response ────────────────────────────────

test('public endpoints never return tenant/client ids, staff PII, contacts, appointments or secrets', async () => {
  const site = await mkSite(await mkTenant());
  // Existing booking with a contact, so there IS something private to leak.
  const first = await post(site.slug, body(site, { staff_id: site.staffId, customer_email: 'cliente.privado@example.com', customer_name: 'Cliente Privado' }));
  assert.equal(first.status, 201);
  const [existing] = await appts(site);

  const from = at(0).toISOString();
  const to = at(23).toISOString();
  const responses = [
    await get('services', site.slug),
    await get('staff', site.slug, `?service_id=${site.serviceId}`),
    await get('availability', site.slug, `?service_id=${site.serviceId}&from=${from}&to=${to}`),
    await get('availability', site.slug, `?service_id=${site.serviceId}&staff_id=${site.staff2Id}&from=${from}&to=${to}`),
    await post(site.slug, body(site, { staff_id: site.staff2Id, start_at: at(16).toISOString() })),
  ];
  const forbidden = [
    site.tenantId,
    site.clientId,
    site.siteId,
    String(existing.id),
    String(existing.contact_id),
    '+573009998877',
    'empleado.privado@example.com',
    'Contacto Emergencia',
    'cliente.privado@example.com',
    'Cliente Privado',
    HASH_SECRET,
    'tenant_id',
    'client_id',
    'contact',
    'conversation',
    'idempotency',
    'buffer',
    'working_hours',
    'phone',
    'email',
    'role',
    'token',
  ];
  for (const res of responses) {
    assert.ok(res.status < 300, `status ${res.status}`);
    const text = await res.text();
    for (const f of forbidden) assert.ok(!text.includes(f), `response must not contain ${f}: ${text.slice(0, 200)}`);
  }
});

test('availability only offers public professionals and stays inside the 14-day window', async () => {
  const site = await mkSite(await mkTenant());
  // A no-chair hire who still has the service linked must never be offered.
  await query(`UPDATE staff SET takes_bookings = false WHERE id = $1`, [site.staff2Id]);
  const from = at(0).toISOString();
  const res = await get('availability', site.slug, `?service_id=${site.serviceId}&from=${from}&to=${at(23).toISOString()}`);
  const d = (await res.json()) as { slots: Array<{ staff_id: string; available_staff_ids: string[] }> };
  assert.ok(d.slots.length > 0);
  for (const s of d.slots) {
    assert.equal(s.staff_id, site.staffId);
    assert.deepEqual(s.available_staff_ids, [site.staffId]);
  }
  const tooWide = await get('availability', site.slug, `?service_id=${site.serviceId}&from=${from}&to=${new Date(at(0).getTime() + 15 * 86_400_000).toISOString()}`);
  assert.equal(tooWide.status, 400);
});
