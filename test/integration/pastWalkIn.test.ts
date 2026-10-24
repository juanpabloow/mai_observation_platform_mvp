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
 * PAST WALK-IN («Atención sin cita · Esta atención ya se realizó») — reception registering at
 * the end of the day a service that ALREADY happened today. Through the REAL server action, the
 * REAL bot route and the REAL public route, on the local test database, with the real clock:
 *   - an authorised login (reception) registers it as COMPLETED, keeping the real creation date
 *     and who registered it; no payment is recorded (the charge stays pending);
 *   - a start in the future, a service that has not ended yet, or another day is refused;
 *   - an overlap with ANY appointment of that professional (a completed one too), a block, or a
 *     login without agenda.book / another professional's column is refused — nothing changes;
 *   - the bot API and the public page cannot ask for it.
 *
 * The site uses the fixed-offset zone whose local time is ~12:00 now, open 08:00–20:00 daily,
 * so «three hours ago» is always inside today's opening hours.
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
const asUser = (userId: string | null) => {
  CURRENT = userId ? { id: userId, email: `${userId.slice(0, 8)}@test.local` } : null;
};

const { createManualAppointmentAction } = await import('../../web/lib/schedulingActions.js');

const savedSecret = process.env.PUBLIC_BOOKING_HASH_SECRET;
process.env.PUBLIC_BOOKING_HASH_SECRET ??= 'test-public-booking-hash-secret-0123456789';
const tenants: string[] = [];
after(async () => {
  if (savedSecret === undefined) delete process.env.PUBLIC_BOOKING_HASH_SECRET;
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

function noonZone(): string {
  const n = new Date().getUTCHours() - 12;
  return n === 0 ? 'Etc/GMT' : n > 0 ? `Etc/GMT+${n}` : `Etc/GMT${n}`;
}
const OPEN_ALL_DAY = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '08:00', end: '20:00' }]]));
const GRID_MS = 30 * 60_000;
/** The slot-grid tick at or before now (whole-hour offset zone → the grid is UTC half-hours). */
const floorTick = () => new Date(Math.floor(Date.now() / GRID_MS) * GRID_MS);

async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true, openingHours: OPEN_ALL_DAY as never });
  tenants.push(s.tenantId);
  await query(`UPDATE sites SET timezone = $2, scheduling_config = jsonb_set(scheduling_config, '{min_notice_min}', to_jsonb(120)) WHERE id = $1`, [s.siteId, noonZone()]);
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const reception = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  return { ...s, owner, reception };
}
type S = Awaited<ReturnType<typeof scenario>>;

const pastWalkIn = (s: S, staffId: string, startAt: Date, extra: Record<string, unknown> = {}) =>
  createManualAppointmentAction(s.clientId, {
    siteId: s.siteId,
    serviceId: s.serviceBeard, // 30 min
    staffId,
    startAt: startAt.toISOString(),
    walkIn: true,
    alreadyDone: true,
    customerName: 'Vino esta mañana',
    contactMode: 'guest',
    idempotencyKey: randomUUID(),
    ...extra,
  });

const at = async (s: S, startAt: Date) =>
  (await query<{ id: string; status: string }>(`SELECT id, status FROM appointments WHERE tenant_id = $1 AND start_at = $2`, [s.tenantId, startAt])).rows;

test('reception registers a service that already happened today: completed, real creation date and author, no payment', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 3 * 3_600_000);
  const before = Date.now();
  const r = await pastWalkIn(s, s.staffA, start);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.ok && r.warning, undefined, 'completed without a warning');
  const row = (
    await query<{ status: string; origin: string; created_by_user_id: string; created_at: Date; start_at: Date; contact_id: string | null; guest_name: string }>(
      `SELECT status, origin, created_by_user_id, created_at, start_at, contact_id, guest_name FROM appointments WHERE id = $1`,
      [r.ok ? r.id : ''],
    )
  ).rows[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.origin, 'walk_in');
  assert.equal(row.created_by_user_id, s.reception, 'who registered it');
  assert.ok(row.created_at.getTime() >= before - 1000 && row.created_at.getTime() <= Date.now() + 1000, 'the REAL creation date (now), not the service time');
  assert.equal(row.start_at.getTime(), start.getTime(), 'the service time as it happened');
  assert.equal(row.guest_name, 'Vino esta mañana');
  const pays = await query(`SELECT 1 FROM payments WHERE appointment_id = $1`, [r.ok ? r.id : '']);
  assert.equal(pays.rowCount, 0, 'the charge is independent: nothing recorded as paid');
  const events = await query<{ event_type: string; actor_user_id: string | null }>(`SELECT event_type, actor_user_id FROM appointment_events WHERE appointment_id = $1 ORDER BY created_at`, [r.ok ? r.id : '']);
  assert.ok(events.rows.some((e) => /creat/.test(e.event_type) && e.actor_user_id === s.reception), JSON.stringify(events.rows));
  assert.ok(events.rows.some((e) => /complet/.test(e.event_type) && e.actor_user_id === s.reception), 'completed by the same login');
});

test('a future start, a service still in progress or another day is refused — nothing is written', async () => {
  const s = await scenario();
  asUser(s.reception);
  const future = new Date(floorTick().getTime() + 2 * 3_600_000);
  const f = await pastWalkIn(s, s.staffA, future);
  assert.equal(f.ok, false);
  assert.match(f.ok ? '' : f.error, /ya terminaron/);
  // Started already (the current tick) but the 30-min service has not ended yet.
  const running = floorTick();
  const g = await pastWalkIn(s, s.staffA, running);
  assert.equal(g.ok, false, 'a service that has not ended is not «ya se realizó»');
  const yesterday = new Date(floorTick().getTime() - 27 * 3_600_000);
  const y = await pastWalkIn(s, s.staffA, yesterday);
  assert.equal(y.ok, false, 'only today, at the site');
  for (const d of [future, running, yesterday]) assert.deepEqual(await at(s, d), []);
  // Without the walk-in flag (or together with «ahora») the option does not exist.
  const start = new Date(floorTick().getTime() - 3 * 3_600_000);
  assert.equal((await pastWalkIn(s, s.staffA, start, { walkIn: false })).ok, false);
  assert.equal((await pastWalkIn(s, s.staffA, start, { immediate: true })).ok, false);
  assert.deepEqual(await at(s, start), []);
});

test('conflicts are shown and nothing else changes: another appointment (even completed) or a block', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 3 * 3_600_000);
  const first = await pastWalkIn(s, s.staffA, start);
  assert.ok(first.ok);
  const again = await pastWalkIn(s, s.staffA, start);
  assert.equal(again.ok, false, 'the professional was already busy (with a COMPLETED appointment)');
  assert.ok(!again.ok && again.conflicts && again.conflicts.length === 1, `the overlap is listed: ${JSON.stringify(again)}`);
  assert.equal(!again.ok && again.conflicts?.[0].status, 'completed');
  assert.deepEqual((await at(s, start)).map((x) => x.status), ['completed'], 'the existing appointment is untouched');

  // A block on Beto then: refused as unavailable, no other appointment altered.
  await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.staffB, startsAt: new Date(start.getTime() - 3_600_000), endsAt: new Date(start.getTime() + 3_600_000), reason: 'Bloqueo' });
  const blocked = await pastWalkIn(s, s.staffB, start);
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok ? '' : blocked.error, /no estaba disponible/);
  assert.deepEqual((await at(s, start)).length, 1);
});

test('without agenda.book, or for another professional\'s column, it is refused on the server', async () => {
  const s = await scenario();
  const start = new Date(floorTick().getTime() - 3 * 3_600_000);
  // A custom role that may SEE the agenda but not operate it.
  const viewer = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const role = (await query<{ id: string }>(`INSERT INTO access_roles (tenant_id, client_id, name, description) VALUES ($1,$2,$3,'test') RETURNING id`, [s.tenantId, s.clientId, `Solo ver ${randomUUID().slice(0, 6)}`])).rows[0];
  await query(`INSERT INTO access_role_permissions (role_id, permission_key) VALUES ($1,'agenda.view')`, [role.id]);
  await query(`UPDATE tenant_members SET client_role = 'custom', access_role_id = $3 WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, viewer, role.id]);
  asUser(viewer);
  assert.equal((await pastWalkIn(s, s.staffA, start)).ok, false, 'agenda.view alone cannot register');
  // A staff login (agenda.book on its OWN column) cannot register in someone else's.
  const staffUser = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,'S',$2,true)`, [staffUser, `s-${staffUser.slice(0, 6)}@t.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1,$2,'member',$3,'staff',$4,$5)`,
    [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
  );
  asUser(staffUser);
  assert.equal((await pastWalkIn(s, s.staffB, start)).ok, false, "never another professional's column");
  // A member of another business of the tenant reaches nothing; nor does a signed-out visitor.
  asUser(await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' }));
  assert.equal((await pastWalkIn(s, s.staffA, start)).ok, false);
  asUser(null);
  await pastWalkIn(s, s.staffA, start).then((r) => assert.equal(r.ok, false), () => undefined);
  assert.deepEqual(await at(s, start), [], 'nothing was written by any of them');
  await query(`DELETE FROM "user" WHERE id = $1`, [staffUser]);
});

test('the bot API and the public page cannot register a past service, whatever the body claims', async () => {
  const s = await scenario();
  const start = new Date(floorTick().getTime() - 3 * 3_600_000);
  asUser(null);
  const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read', 'scheduling.write']);
  const { POST: BotPost } = await import('../../web/app/api/scheduling/v1/appointments/route.js');
  const bot = await BotPost(
    new Request('http://t/api/scheduling/v1/appointments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify({ site_id: s.siteId, service_id: s.serviceBeard, staff_id: s.staffA, start_at: start.toISOString(), customer_name: 'Bot', customer_phone: '+573005550199', walk_in: true, already_done: true, alreadyDone: true, past_walk_in: true }),
    }),
  );
  assert.ok(bot.status >= 400 && bot.status < 500, `bot refused (got ${bot.status})`);

  const slug = (await query<{ slug: string }>(`SELECT slug FROM sites WHERE id = $1`, [s.siteId])).rows[0].slug;
  const { POST: PublicPost } = (await import('../../web/app/api/booking/[slug]/route.js')) as { POST: (req: Request, ctx: { params: Promise<{ slug: string }> }) => Promise<Response> };
  const pub = await PublicPost(
    new Request(`http://localhost/api/booking/${slug}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, 'idempotency-key': randomUUID() },
      body: JSON.stringify({ service_id: s.serviceBeard, staff_id: s.staffA, start_at: start.toISOString(), customer_name: 'Visitante', customer_phone: `300${String(Date.now()).slice(-7)}`, privacy_accepted: true, already_done: true, alreadyDone: true }),
    }),
    { params: Promise.resolve({ slug }) },
  );
  assert.ok(pub.status >= 400 && pub.status < 500, `public page refused (got ${pub.status})`);
  assert.deepEqual(await at(s, start), [], 'neither booked anything in the past');
});
