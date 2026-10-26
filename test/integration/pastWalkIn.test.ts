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
 * PAST WALK-IN («Registrar atención realizada») — reception recording a service that ALREADY
 * happened, today or an earlier day, at its real start. Through the REAL server actions, the
 * REAL bot routes and the REAL public route, on the local test database, with the real clock:
 *   - an authorised login (reception) registers it as COMPLETED, keeping the real creation date
 *     and who registered it; no payment is recorded (the charge stays pending);
 *   - a week ago and off the slot grid (the real minute) is fine; the professional's own
 *     duration sets the end; the check before confirming says the same as the write;
 *   - a start in the future or a service that has not ended yet is refused;
 *   - an overlap with an ACTIVE or COMPLETED appointment of that professional (returned, so it
 *     can be opened and completed instead), a block, or a login without agenda.book / another
 *     professional's column is refused — nothing changes; a NO-SHOW does not block;
 *   - the sale it belongs to is won; no review is requested by the bot API for it;
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

const { createManualAppointmentAction, checkPastAttendanceAction } = await import('../../web/lib/schedulingActions.js');

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

test('a future start or a service still in progress is refused — nothing is written', async () => {
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
  assert.deepEqual(!g.ok && g.problems?.map((p) => p.code), ['not_ended'], 'and it says when it ends');
  const ck = await checkPastAttendanceAction(s.clientId, { siteId: s.siteId, serviceId: s.serviceBeard, staffId: s.staffA, startAt: running.toISOString() });
  assert.ok(ck.ok && ck.problems.some((p) => p.code === 'not_ended'), 'the check before confirming says the same');
  for (const d of [future, running]) assert.deepEqual(await at(s, d), []);
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
  assert.deepEqual(!blocked.ok && blocked.problems?.map((p) => p.code), ['absence'], 'with the rule that was in the way');
  assert.deepEqual((await at(s, start)).length, 1);
});

test('created and completed in ONE transaction: if completing fails, nothing is left registered', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 3 * 3_600_000);
  // Force the «completed» write to fail INSIDE the transaction (a test-only trigger on the
  // audit event this path writes), with a contact to be created too: all must roll back.
  const fn = `t_fail_past_${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  await query(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.event_type = 'appointment_completed' AND (NEW.detail->>'already_done') = 'true' THEN RAISE EXCEPTION 'forced failure'; END IF;
      RETURN NEW; END $$`);
  await query(`CREATE TRIGGER ${fn} BEFORE INSERT ON appointment_events FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  try {
    const phone = `+57300${String(Date.now()).slice(-7)}`;
    const r = await pastWalkIn(s, s.staffA, start, { customerPhone: phone, contactMode: 'create' }).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    assert.equal(r.ok, false, 'the failure is reported');
    assert.deepEqual(await at(s, start), [], 'no appointment half-registered (not even «Sin confirmar»)');
    const contacts = await query(`SELECT 1 FROM contacts WHERE tenant_id = $1 AND phone_e164 = $2`, [s.tenantId, phone]);
    assert.equal(contacts.rowCount, 0, 'and no contact created by it');
  } finally {
    await query(`DROP TRIGGER IF EXISTS ${fn} ON appointment_events`);
    await query(`DROP FUNCTION IF EXISTS ${fn}()`);
  }
  // Without the forced failure the same registration goes through, completed.
  const ok = await pastWalkIn(s, s.staffA, start);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.deepEqual((await at(s, start)).map((x) => x.status), ['completed']);
});

test('two registrations at once for the same professional and time: exactly one, the other is told why', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 4 * 3_600_000);
  const [a, b] = await Promise.all([pastWalkIn(s, s.staffB, start), pastWalkIn(s, s.staffB, start)]);
  assert.equal([a, b].filter((x) => x.ok).length, 1, `one wins: ${JSON.stringify([a, b])}`);
  const lost = [a, b].find((x) => !x.ok);
  assert.match(lost && !lost.ok ? lost.error : '', /se cruza/);
  assert.deepEqual((await at(s, start)).map((x) => x.status), ['completed']);
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

test('an earlier day at its real minute (off the grid): completed, start stored as typed, end from the professional\'s own duration', async () => {
  const s = await scenario();
  asUser(s.reception);
  // Beto does the beard in 45 min (his own duration), not the service's 30.
  await query(`UPDATE staff_services SET duration_override_min = 45 WHERE staff_id = $1 AND service_id = $2`, [s.staffB, s.serviceBeard]);
  const start = new Date(floorTick().getTime() - 7 * 24 * 3_600_000 - 3 * 3_600_000 + 7 * 60_000); // a week ago, «:07»
  const ck = await checkPastAttendanceAction(s.clientId, { siteId: s.siteId, serviceId: s.serviceBeard, staffId: s.staffB, startAt: start.toISOString() });
  assert.ok(ck.ok, JSON.stringify(ck));
  assert.equal(ck.ok && ck.durationMin, 45);
  assert.equal(ck.ok && ck.serviceEndAt, new Date(start.getTime() + 45 * 60_000).toISOString());
  assert.deepEqual(ck.ok && [ck.problems, ck.conflicts, ck.noShows], [[], [], []]);
  assert.deepEqual(await at(s, start), [], 'the check writes nothing');
  const r = await pastWalkIn(s, s.staffB, start);
  assert.ok(r.ok, JSON.stringify(r));
  const row = (await query<{ status: string; start_at: Date; service_end_at: Date; duration_min_snapshot: number; created_at: Date }>(
    `SELECT status, start_at, service_end_at, duration_min_snapshot, created_at FROM appointments WHERE id = $1`, [r.ok ? r.id : ''])).rows[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.start_at.toISOString(), start.toISOString(), 'the real start, not snapped to the grid');
  assert.equal(row.duration_min_snapshot, 45);
  assert.equal(row.service_end_at.toISOString(), new Date(start.getTime() + 45 * 60_000).toISOString());
  assert.ok(Date.now() - row.created_at.getTime() < 60_000, 'created_at is when it was registered, a week later');
});

test('a no-show in that time does not block (someone else was attended); it stays a no-show', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 2 * 24 * 3_600_000 - 3 * 3_600_000);
  const noShow = await insertPast(s, s.staffA, start, 'no_show', 'Pedro no vino');
  const ck = await checkPastAttendanceAction(s.clientId, { siteId: s.siteId, serviceId: s.serviceBeard, staffId: s.staffA, startAt: start.toISOString() });
  assert.ok(ck.ok && ck.conflicts.length === 0 && ck.noShows.length === 1 && ck.noShows[0].id === noShow, JSON.stringify(ck));
  const r = await pastWalkIn(s, s.staffA, start);
  assert.ok(r.ok, JSON.stringify(r));
  const rows = await query<{ id: string; status: string }>(`SELECT id, status FROM appointments WHERE tenant_id = $1 AND start_at = $2 ORDER BY status`, [s.tenantId, start]);
  assert.deepEqual(rows.rows.map((x) => x.status).sort(), ['completed', 'no_show'], 'the no-show is untouched');
});

test('an existing appointment that was never marked blocks a duplicate and is returned to open and complete it', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 24 * 3_600_000 - 3 * 3_600_000);
  const existing = await insertPast(s, s.staffB, start, 'confirmed', 'Lucía ya tenía cita');
  const r = await pastWalkIn(s, s.staffB, new Date(start.getTime() + 10 * 60_000));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.conflicts?.length === 1, JSON.stringify(r));
  const c = !r.ok ? r.conflicts![0] : null;
  assert.equal(c?.id, existing, 'which appointment, to open it');
  assert.equal(c?.customer, 'Lucía ya tenía cita');
  assert.equal(c?.status, 'confirmed');
  assert.ok(c && /^\d{4}-\d{2}-\d{2}$/.test(c.dayKey));
  const still = (await query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [existing])).rows[0];
  assert.equal(still.status, 'confirmed', 'nothing was changed');
});

test('the sale of a recorded visit is won, nothing is sent, and the bot API asks no review for it', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 3 * 24 * 3_600_000 - 3 * 3_600_000);
  const phone = `+57301${String(Date.now()).slice(-7)}`;
  const r = await pastWalkIn(s, s.staffA, start, { customerName: 'Cliente con venta', customerPhone: phone, contactMode: 'create' });
  assert.ok(r.ok, JSON.stringify(r));
  const id = r.ok ? r.id : '';
  const opp = (await query<{ status: string; stage: string }>(
    `SELECT o.status, o.stage FROM opportunities o JOIN appointments a ON a.opportunity_id = o.id WHERE a.id = $1`, [id])).rows[0];
  assert.deepEqual(opp, { status: 'won', stage: 'attended' }, 'the same as «Completar»: attended and won');
  const ev = (await query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM scheduling_events WHERE tenant_id = $1 AND event_type = 'appointment.status_changed' AND payload->>'appointment_id' = $2`, [s.tenantId, id])).rows;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payload.already_done, true, 'the realtime hint says it was recorded afterwards');
  const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read', 'scheduling.write']);
  const { POST: ReviewPost } = (await import('../../web/app/api/scheduling/v1/appointments/[id]/review-link/route.js')) as { POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response> };
  const res = await ReviewPost(
    new Request(`http://t/api/scheduling/v1/appointments/${id}/review-link`, { method: 'POST', headers: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef } }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'registered_after_service');
  assert.equal((await query(`SELECT 1 FROM appointment_reviews WHERE appointment_id = $1`, [id])).rowCount, 0, 'no review request exists');
});

test('a staff login checks and records only in its own column', async () => {
  const s = await scenario();
  const start = new Date(floorTick().getTime() - 24 * 3_600_000 - 2 * 3_600_000);
  const staffUser = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,'S',$2,true)`, [staffUser, `p-${staffUser.slice(0, 6)}@t.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1,$2,'member',$3,'staff',$4,$5)`,
    [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
  );
  asUser(staffUser);
  const other = await checkPastAttendanceAction(s.clientId, { siteId: s.siteId, serviceId: s.serviceBeard, staffId: s.staffB, startAt: start.toISOString() });
  assert.equal(other.ok, false, "never another professional's column, not even to read it");
  const own = await pastWalkIn(s, s.staffA, start);
  assert.ok(own.ok, JSON.stringify(own));
  await query(`DELETE FROM tenant_members WHERE user_id = $1`, [staffUser]);
  await query(`DELETE FROM "user" WHERE id = $1`, [staffUser]);
});

test('the same form sent twice at once (double click, retry): one appointment, both answers point to it', async () => {
  const s = await scenario();
  asUser(s.reception);
  const start = new Date(floorTick().getTime() - 5 * 24 * 3_600_000 - 3 * 3_600_000);
  const key = randomUUID();
  const [a, b] = await Promise.all([pastWalkIn(s, s.staffA, start, { idempotencyKey: key }), pastWalkIn(s, s.staffA, start, { idempotencyKey: key })]);
  assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
  assert.equal(a.ok && b.ok && a.id, b.ok ? b.id : '', 'the same appointment');
  assert.deepEqual((await at(s, start)).map((x) => x.status), ['completed']);
});

async function insertPast(s: S, staffId: string, start: Date, status: string, guest: string): Promise<string> {
  const end = new Date(start.getTime() + 30 * 60_000);
  const r = await query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
       service_name_snapshot, duration_min_snapshot, status, origin, created_by_type, guest_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Beard trim',30,$8,'public','public',$9) RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, staffId, s.serviceBeard, start, end, status, guest],
  );
  return r.rows[0].id;
}
