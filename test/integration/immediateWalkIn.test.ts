import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { createException } from '../../src/db/repositories/scheduling/exceptions.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * IMMEDIATE WALK-IN («Atención sin cita · ahora») — the ONE exception to the site's minimum
 * notice (src/scheduling/immediate.ts). Proven through the REAL server action, the REAL
 * internal availability route, the REAL bot route and the REAL public booking route, on the
 * local test database, with the real clock:
 *   - an authorised agenda login registers someone who is here NOW despite a 2 h notice;
 *   - it does NOT apply to a later start, to another day, to a non-walk-in booking, to the
 *     bot API or to the public page — those keep the notice;
 *   - every other rule (blocks, the staff login's own column, the business) still applies.
 *
 * "Now" must fall inside opening hours whenever the suite runs, so the site uses the fixed
 * offset zone (Etc/GMT±N) whose local time is ~12:00 at this moment, open 08:00–20:00 daily.
 */

let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: {
    getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null),
  },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('unexpected redirect()'); },
    notFound: () => { throw new Error('unexpected notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (userId: string) => {
  CURRENT = { id: userId, email: `${userId.slice(0, 8)}@test.local` };
};

const { createManualAppointmentAction } = await import('../../web/lib/schedulingActions.js');
const { GET: InternalAvailability } = await import('../../web/app/api/scheduling/internal/availability/route.js');

const savedSecret = process.env.PUBLIC_BOOKING_HASH_SECRET;
process.env.PUBLIC_BOOKING_HASH_SECRET ??= 'test-public-booking-hash-secret-0123456789';
const tenants: string[] = [];
after(async () => {
  if (savedSecret === undefined) delete process.env.PUBLIC_BOOKING_HASH_SECRET;
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** The fixed-offset zone whose local time is now ≈ 12:xx (Etc/GMT+N means UTC−N). */
function noonZone(): string {
  const n = new Date().getUTCHours() - 12; // -12 … 11
  return n === 0 ? 'Etc/GMT' : n > 0 ? `Etc/GMT+${n}` : `Etc/GMT${n}`;
}
const OPEN_ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '08:00', end: '20:00' }]]));
const NOTICE_MIN = 120;
const INTERVAL_MIN = 30; // fixture grid → immediate window = max(15, 30) = 30 min

async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true, openingHours: OPEN_ALL_DAY as never });
  tenants.push(s.tenantId);
  await query(
    `UPDATE sites SET timezone = $2, scheduling_config = jsonb_set(scheduling_config, '{min_notice_min}', to_jsonb($3::int)) WHERE id = $1`,
    [s.siteId, noonZone(), NOTICE_MIN],
  );
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  return { ...s, owner };
}

type S = Awaited<ReturnType<typeof scenario>>;

/** Starts the internal (agenda) availability route offers for a professional, from now. */
async function internalStarts(s: S, staffId: string, immediate: boolean): Promise<Date[]> {
  const p = new URLSearchParams({
    client_id: s.clientId,
    site_id: s.siteId,
    service_id: s.serviceBeard,
    staff_id: staffId,
    from: new Date().toISOString(),
    to: new Date(Date.now() + 8 * 3_600_000).toISOString(),
  });
  if (immediate) p.set('immediate', '1');
  const r = await InternalAvailability(new Request(`http://t/api/scheduling/internal/availability?${p.toString()}`));
  assert.equal(r.status, 200, await r.clone().text());
  return ((await r.json()) as { slots: Array<{ start_at: string }> }).slots.map((x) => new Date(x.start_at));
}

const walkIn = (s: S, staffId: string, startAt: Date, extra: Record<string, unknown> = {}) =>
  createManualAppointmentAction(s.clientId, {
    siteId: s.siteId,
    serviceId: s.serviceBeard,
    staffId,
    startAt: startAt.toISOString(),
    walkIn: true,
    immediate: true,
    customerName: 'Llegó sin reserva',
    contactMode: 'guest',
    idempotencyKey: randomUUID(),
    ...extra,
  });

const countAt = async (s: S, startAt: Date) =>
  (await query(`SELECT 1 FROM appointments WHERE tenant_id = $1 AND start_at = $2 AND status IN ('scheduled','confirmed')`, [s.tenantId, startAt])).rowCount;

test('the agenda offers «ahora» inside the immediate window only, and nothing else waives the notice', async () => {
  const s = await scenario();
  asUser(s.owner);
  const now = Date.now();
  const immediate = await internalStarts(s, s.staffA, true);
  assert.ok(immediate.length >= 1, 'someone free now has an immediate start');
  for (const d of immediate) {
    assert.ok(d.getTime() >= now - 60_000 && d.getTime() <= now + INTERVAL_MIN * 60_000 + 5_000, `immediate start ${d.toISOString()} is inside the window`);
  }
  const normal = await internalStarts(s, s.staffA, false);
  assert.ok(normal.length > 0);
  assert.ok(normal.every((d) => d.getTime() >= now + NOTICE_MIN * 60_000 - 5_000), 'normal availability keeps the 2 h notice');
});

test('an authorised walk-in NOW is registered despite the notice; a later start or a normal booking is not', async () => {
  const s = await scenario();
  asUser(s.owner);
  const [nowStart] = await internalStarts(s, s.staffA, true);
  assert.ok(nowStart);

  // A NON-walk-in manual booking at the same start keeps the notice, even if it asks for it.
  const manual = await walkIn(s, s.staffA, nowStart, { walkIn: false });
  assert.equal(manual.ok, false, 'a normal booking near now is refused by the notice');
  // A walk-in WITHOUT the immediate flag keeps the notice too.
  const plain = await walkIn(s, s.staffA, nowStart, { immediate: false });
  assert.equal(plain.ok, false, 'a walk-in that is not «ahora» keeps the notice');
  assert.equal(await countAt(s, nowStart), 0);

  const ok = await walkIn(s, s.staffA, nowStart);
  assert.ok(ok.ok, JSON.stringify(ok));
  const row = await query<{ origin: string; contact_id: string | null; guest_name: string }>(`SELECT origin, contact_id, guest_name FROM appointments WHERE id = $1`, [ok.ok ? ok.id : '']);
  assert.deepEqual(row.rows[0], { origin: 'walk_in', contact_id: null, guest_name: 'Llegó sin reserva' });

  // The SAME exception asked for a FUTURE start — later today (past the window) or another
  // day — is refused as «not now»: a future booking never skips the notice.
  const laterToday = new Date(nowStart.getTime() + 3 * 3_600_000);
  const later = await walkIn(s, s.staffB, laterToday);
  assert.equal(later.ok, false);
  assert.match(later.ok ? '' : later.error, /ahora/, 'refused as not immediate');
  const tomorrow = new Date(nowStart.getTime() + 24 * 3_600_000);
  const nextDay = await walkIn(s, s.staffB, tomorrow);
  assert.equal(nextDay.ok, false, 'another day is never «ahora»');
  assert.equal(await countAt(s, laterToday), 0);
  assert.equal(await countAt(s, tomorrow), 0);
  // …while that later start, as a NORMAL walk-in past the notice, is fine.
  const normalLater = await walkIn(s, s.staffB, laterToday, { immediate: false });
  assert.ok(normalLater.ok, JSON.stringify(normalLater));
});

test('every other rule still applies to «ahora»: a block, the slot already taken, the staff login column, another business', async () => {
  const s = await scenario();
  asUser(s.owner);
  const [nowStart] = await internalStarts(s, s.staffA, true);
  assert.ok(nowStart);

  // A block on Beto covering now: no immediate start offered, and the action refuses it.
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.staffB, startsAt: new Date(Date.now() - 3_600_000), endsAt: new Date(Date.now() + 3 * 3_600_000), reason: 'Bloqueo' });
  assert.deepEqual(await internalStarts(s, s.staffB, true), [], 'a blocked professional has no «ahora»');
  assert.equal((await walkIn(s, s.staffB, nowStart)).ok, false, 'the block is enforced on the server');

  // The slot taken: the second «ahora» at the same start for the same professional fails.
  assert.ok((await walkIn(s, s.staffA, nowStart)).ok);
  assert.equal((await walkIn(s, s.staffA, nowStart)).ok, false, 'no double booking');

  // A staff login (agenda.book on its OWN column) cannot use it for someone else's column.
  const staffUser = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,'S',$2,true)`, [staffUser, `s-${staffUser.slice(0, 6)}@t.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1,$2,'member',$3,'staff',$4,$5)`,
    [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
  );
  asUser(staffUser);
  const other = await walkIn(s, s.staffB, new Date(nowStart.getTime() + INTERVAL_MIN * 60_000));
  assert.equal(other.ok, false, "a staff login never books another professional's column");

  // A member of ANOTHER business of the tenant reaches nothing.
  const outsider = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  asUser(outsider);
  assert.equal((await walkIn(s, s.staffA, nowStart)).ok, false, 'another business is refused');
  const p = new URLSearchParams({ client_id: s.clientId, site_id: s.siteId, service_id: s.serviceBeard, from: new Date().toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), immediate: '1' });
  assert.equal((await InternalAvailability(new Request(`http://t/api/scheduling/internal/availability?${p.toString()}`))).status, 404);
  await query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [[staffUser]]);
});

test('the BOT API keeps the notice near now — even if the body claims a walk-in «ahora»', async () => {
  const s = await scenario();
  asUser(s.owner);
  const [nowStart] = await internalStarts(s, s.staffA, true);
  assert.ok(nowStart);
  CURRENT = null; // the bot has no session — only its token

  const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read', 'scheduling.write']);
  const { POST } = await import('../../web/app/api/scheduling/v1/appointments/route.js');
  const send = (extra: Record<string, unknown>) =>
    POST(
      new Request('http://t/api/scheduling/v1/appointments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ site_id: s.siteId, service_id: s.serviceBeard, staff_id: s.staffA, start_at: nowStart.toISOString(), customer_name: 'Bot', customer_phone: '+573005550199', ...extra }),
      }),
    );
  const plain = await send({});
  assert.equal(plain.status, 409, await plain.clone().text());
  const claimed = await send({ walk_in: true, immediate: true, origin: 'walk_in' });
  assert.ok(claimed.status >= 400, `a crafted body is refused (got ${claimed.status})`);
  assert.equal(await countAt(s, nowStart), 0, 'the bot booked nothing near now');
  // The control: the same token books fine past the notice (so the refusal above IS the notice).
  const ok = await send({ start_at: new Date(nowStart.getTime() + 3 * 3_600_000).toISOString() });
  assert.equal(ok.status, 201, await ok.clone().text());
});

test('the PUBLIC booking page keeps the notice near now — even if the body claims «ahora»', async () => {
  const s = await scenario();
  asUser(s.owner);
  const [nowStart] = await internalStarts(s, s.staffA, true);
  assert.ok(nowStart);
  CURRENT = null; // a visitor — no session

  const slug = (await query<{ slug: string }>(`SELECT slug FROM sites WHERE id = $1`, [s.siteId])).rows[0].slug;
  const { POST } = (await import('../../web/app/api/booking/[slug]/route.js')) as { POST: (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response> };
  const send = (extra: Record<string, unknown>) =>
    POST(
      new Request(`http://localhost/api/booking/${slug}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'idempotency-key': randomUUID() },
        body: JSON.stringify({ service_id: s.serviceBeard, staff_id: s.staffA, start_at: nowStart.toISOString(), customer_name: 'Visitante', customer_phone: `300${String(Date.now()).slice(-7)}`, privacy_accepted: true, ...extra }),
      }),
      { params: Promise.resolve({ slug }) },
    );
  const plain = await send({});
  assert.ok(plain.status >= 400 && plain.status < 500, `near now is refused (got ${plain.status}: ${await plain.clone().text()})`);
  const claimed = await send({ walk_in: true, immediate: true });
  assert.ok(claimed.status >= 400 && claimed.status < 500, `a crafted body is refused (got ${claimed.status})`);
  assert.equal(await countAt(s, nowStart), 0, 'the public page booked nothing near now');

  // The control: the same page books fine past the notice (so the refusal above IS the notice).
  const later = new Date(nowStart.getTime() + 3 * 3_600_000);
  const ok = await send({ start_at: later.toISOString() });
  assert.equal(ok.status, 201, await ok.clone().text());
});
