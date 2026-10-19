import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { insertAppointment } from '../../src/db/repositories/scheduling/appointments.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, type Scenario } from './fixtures.js';

/**
 * "CAMBIAR FECHA Y HORA" end to end — the REAL internal availability route and the REAL
 * reschedule action against PostgreSQL; only the session read and Next's request
 * boundaries are stubbed (same pattern as timeOffPermissions.test.ts).
 *
 *  - availability FOR an appointment: its own block excluded, its STORED duration used,
 *    every other booking respected; refused for another client, a terminal appointment or
 *    a staff login looking at someone else's appointment;
 *  - the move keeps the SAME appointment (id, client, service, price, duration, state),
 *    records who and before/after, and refuses: no change, a stale view, a taken slot, a
 *    terminal appointment, a staff login on another column, another client/tenant.
 */

let CURRENT: { id: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: `${CURRENT.id.slice(0, 8)}@test.local` }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('refused: redirect()'); },
    notFound: () => { throw new Error('refused: notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const { rescheduleAppointmentAction } = await import('../../web/lib/schedulingActions.js');
const { GET: availabilityGET } = (await import('../../web/app/api/scheduling/internal/availability/route.js')) as { GET: (req: Request) => Promise<Response> };

const tenants: string[] = [];
const users: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  if (users.length) await query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [users]);
  await closeDb();
});
const as = (id: string | null) => {
  CURRENT = id ? { id } : null;
};

async function scenario(): Promise<Scenario> {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}

/** A staff login bound to ONE professional (its own column). */
async function staffLogin(s: Scenario, staffId: string): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Staff', $2, true)`, [id, `st-${id.slice(0, 8)}@test.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
       VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
    [s.tenantId, id, s.clientId, s.siteId, staffId],
  );
  users.push(id);
  return id;
}

// Monday 2 Nov 2026 in Bogotá (UTC-5): 10:00 = 15:00Z.
const at = (hhmm: string) => new Date(`2026-11-02T${String(Number(hhmm.slice(0, 2)) + 5).padStart(2, '0')}:${hhmm.slice(3)}:00.000Z`);

/** A synthetic appointment with an explicit STORED duration (may differ from the catalogue). */
async function appointment(s: Scenario, opts: { staffId?: string; start: string; durationMin: number; status?: string; price?: string | null }) {
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Cliente Sintético' });
  const start = at(opts.start);
  const end = new Date(start.getTime() + opts.durationMin * 60_000);
  const a = await withTransaction((c) =>
    insertAppointment(c, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId, sourceConversationId: null,
      staffId: opts.staffId ?? s.staffA, serviceId: s.serviceHaircut, startAt: start, serviceEndAt: end, blockedFrom: start, blockedUntil: end,
      serviceNameSnapshot: 'Corte (histórico)', durationMinSnapshot: opts.durationMin, priceSnapshot: opts.price ?? '45000',
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0, origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  if (opts.status && opts.status !== 'scheduled') await query(`UPDATE appointments SET status = $2 WHERE id = $1`, [a.id, opts.status]);
  return a.id;
}

async function availability(s: Scenario, params: Record<string, string>) {
  const p = new URLSearchParams({
    client_id: s.clientId,
    site_id: s.siteId,
    service_id: s.serviceHaircut,
    from: at('00:00').toISOString().replace('05:00:00', '05:00:00'),
    to: new Date(at('00:00').getTime() + 24 * 3600_000).toISOString(),
    ...params,
  });
  const res = await availabilityGET(new Request(`http://localhost/api/scheduling/internal/availability?${p.toString()}`));
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as { slots: Array<{ start_at: string; service_end_at: string; available_staff_ids: string[] }> }) : null };
}

const row = (id: string) =>
  query<{ id: string; status: string; staff_id: string; service_id: string; contact_id: string; service_name_snapshot: string; duration_min_snapshot: number; price_snapshot: string; start_at: Date; service_end_at: Date; version: number }>(
    `SELECT id, status, staff_id, service_id, contact_id, service_name_snapshot, duration_min_snapshot, price_snapshot::text AS price_snapshot, start_at, service_end_at, version FROM appointments WHERE id = $1`,
    [id],
  ).then((r) => r.rows[0]);
const events = (id: string) =>
  query<{ event_type: string; actor_user_id: string | null; detail: { from: { start_at: string; staff_id: string }; to: { start_at: string; staff_id: string } } }>(
    `SELECT event_type, actor_user_id, detail FROM appointment_events WHERE appointment_id = $1 AND event_type = 'appointment_rescheduled' ORDER BY created_at`,
    [id],
  ).then((r) => r.rows);

async function refused(fn: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await fn()).ok === false;
  } catch {
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────

test('availability FOR an appointment: own block excluded, stored duration, other bookings respected', async () => {
  const s = await scenario();
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  users.push(owner);
  as(owner);
  // The appointment: 10:00, a 40-min STORED duration (the service now lasts 60).
  const id = await appointment(s, { start: '10:00', durationMin: 40 });
  // Another booking of the same professional: 12:00–13:00.
  await appointment(s, { start: '12:00', durationMin: 60 });

  const generic = await availability(s, { staff_id: s.staffA });
  assert.equal(generic.status, 200);
  const g = new Map(generic.body!.slots.map((x) => [x.start_at, x]));
  assert.ok(!g.has(at('10:00').toISOString()), 'without appointment_id its own time is busy');
  assert.equal(g.get(at('09:00').toISOString())?.service_end_at, at('10:00').toISOString(), 'catalogue duration (60) for a new booking');

  const moving = await availability(s, { staff_id: s.staffA, appointment_id: id });
  assert.equal(moving.status, 200);
  const m = new Map(moving.body!.slots.map((x) => [x.start_at, x]));
  assert.ok(m.has(at('10:00').toISOString()), 'its own time is not a conflict with itself');
  assert.ok(m.has(at('10:30').toISOString()), 'a small move overlapping its current time is offered');
  assert.equal(m.get(at('10:30').toISOString())?.service_end_at, at('11:10').toISOString(), 'the STORED 40 min, not the catalogue 60');
  assert.ok(m.has(at('11:00').toISOString()), '11:00–11:40 fits before the other booking');
  assert.ok(!m.has(at('11:30').toISOString()), '11:30–12:10 would overlap the 12:00 booking');
  assert.ok(!m.has(at('12:00').toISOString()) && !m.has(at('12:30').toISOString()), 'the other booking is still busy');
  assert.ok(m.has(at('13:00').toISOString()));
});

test('availability FOR an appointment is refused outside the login\'s reach or when it can no longer move', async () => {
  const s = await scenario();
  const other = await scenario();
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  users.push(owner);
  const mine = await appointment(s, { start: '10:00', durationMin: 60 });
  const beto = await appointment(s, { start: '11:00', durationMin: 60, staffId: s.staffB });
  const cancelled = await appointment(s, { start: '14:00', durationMin: 60, status: 'cancelled' });
  const foreign = await appointment(other, { start: '10:00', durationMin: 60 });
  const anaLogin = await staffLogin(s, s.staffA);

  as(owner);
  assert.equal((await availability(s, { staff_id: s.staffA, appointment_id: cancelled })).status, 404, 'terminal');
  assert.equal((await availability(s, { staff_id: s.staffA, appointment_id: foreign })).status, 404, 'another tenant');
  assert.equal((await availability(s, { staff_id: s.staffA, appointment_id: 'not-a-uuid' })).status, 404);
  as(anaLogin);
  assert.equal((await availability(s, { staff_id: s.staffA, appointment_id: mine })).status, 200, 'own appointment');
  assert.equal((await availability(s, { staff_id: s.staffB, appointment_id: beto })).status, 404, 'another professional\'s appointment');
  as(null);
  assert.equal((await availability(s, { staff_id: s.staffA, appointment_id: mine })).status, 404, 'anonymous');
});

test('the move keeps the SAME appointment and records who and before/after', async () => {
  const s = await scenario();
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  users.push(owner);
  as(owner);
  const id = await appointment(s, { start: '10:00', durationMin: 40, price: '45000' });
  await query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [id]);
  const before = await row(id);

  const r = await rescheduleAppointmentAction(s.clientId, id, at('15:00').toISOString(), null, { startAt: at('10:00').toISOString(), staffId: s.staffA });
  assert.deepEqual(r, { ok: true });
  const moved = await row(id);
  assert.equal(moved.id, before.id);
  assert.equal(moved.contact_id, before.contact_id, 'same client');
  assert.equal(moved.service_id, before.service_id);
  assert.equal(moved.service_name_snapshot, 'Corte (histórico)', 'service snapshot untouched');
  assert.equal(moved.price_snapshot, before.price_snapshot, 'price untouched');
  assert.equal(moved.duration_min_snapshot, 40, 'stored duration untouched');
  assert.equal(moved.status, 'confirmed', 'confirmation state untouched');
  assert.equal(moved.start_at.toISOString(), at('15:00').toISOString());
  assert.equal(moved.service_end_at.toISOString(), at('15:40').toISOString(), 'ends with the STORED duration');
  assert.equal(moved.version, before.version + 1);
  const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(n.rows[0].n, 1, 'no second appointment was created');
  const ev = await events(id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor_user_id, owner, 'who');
  assert.equal(new Date(ev[0].detail.from.start_at).toISOString(), at('10:00').toISOString());
  assert.equal(new Date(ev[0].detail.to.start_at).toISOString(), at('15:00').toISOString());

  // Changing the professional (an owner may): recorded too.
  const r2 = await rescheduleAppointmentAction(s.clientId, id, at('15:00').toISOString(), s.staffB, { startAt: at('15:00').toISOString(), staffId: s.staffA });
  assert.deepEqual(r2, { ok: true });
  assert.equal((await row(id)).staff_id, s.staffB);
  const ev2 = await events(id);
  assert.equal(ev2[1].detail.from.staff_id, s.staffA);
  assert.equal(ev2[1].detail.to.staff_id, s.staffB);
});

test('refusals: no change, stale view, taken slot, terminal state — nothing written', async () => {
  const s = await scenario();
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  users.push(owner);
  as(owner);
  const id = await appointment(s, { start: '10:00', durationMin: 60 });
  await appointment(s, { start: '13:00', durationMin: 60 });
  const done = await appointment(s, { start: '16:00', durationMin: 60, status: 'completed' });
  const before = await row(id);
  const expected = { startAt: at('10:00').toISOString(), staffId: s.staffA };

  const same = await rescheduleAppointmentAction(s.clientId, id, at('10:00').toISOString(), null, expected);
  assert.equal(same.ok, false);
  assert.match(same.ok ? '' : same.error, /distintos a los actuales/);

  const stale = await rescheduleAppointmentAction(s.clientId, id, at('11:00').toISOString(), null, { startAt: at('09:00').toISOString(), staffId: s.staffA });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? '' : stale.error, /cambió mientras la editabas/);

  const taken = await rescheduleAppointmentAction(s.clientId, id, at('13:00').toISOString(), null, expected);
  assert.equal(taken.ok, false);
  assert.match(taken.ok ? '' : taken.error, /ya no está disponible/);

  const terminal = await rescheduleAppointmentAction(s.clientId, done, at('11:00').toISOString(), null, { startAt: at('16:00').toISOString(), staffId: s.staffA });
  assert.equal(terminal.ok, false);
  assert.match(terminal.ok ? '' : terminal.error, /ya se completó/);

  const after = await row(id);
  assert.equal(after.version, before.version, 'nothing written');
  assert.equal((await events(id)).length, 0, 'no history entry');
});

test('double submit / two operators: exactly one move lands, the other sees a stale view', async () => {
  const s = await scenario();
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  users.push(owner);
  as(owner);
  const id = await appointment(s, { start: '10:00', durationMin: 60 });
  const expected = { startAt: at('10:00').toISOString(), staffId: s.staffA };
  const results = await Promise.all([
    rescheduleAppointmentAction(s.clientId, id, at('14:00').toISOString(), null, expected),
    rescheduleAppointmentAction(s.clientId, id, at('15:00').toISOString(), null, expected),
  ]);
  assert.equal(results.filter((r) => r.ok).length, 1, 'one wins');
  const loser = results.find((r) => !r.ok);
  assert.ok(loser && !loser.ok && /cambió mientras la editabas|ya no está disponible|Alguien acaba/.test(loser.error));
  assert.equal((await events(id)).length, 1, 'one history entry');
});

test('permissions: staff only own column, never another\'s; other clients and tenants refused', async () => {
  const s = await scenario();
  const other = await scenario();
  const anaLogin = await staffLogin(s, s.staffA);
  const otherClientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  const foreignOwner = await seedMember(other.tenantId, { role: 'owner' });
  users.push(otherClientOwner, foreignOwner);
  const anas = await appointment(s, { start: '10:00', durationMin: 60 });
  const betos = await appointment(s, { start: '11:00', durationMin: 60, staffId: s.staffB });
  const exp = (start: string, staff: string) => ({ startAt: at(start).toISOString(), staffId: staff });

  as(anaLogin);
  assert.ok(await refused(() => rescheduleAppointmentAction(s.clientId, betos, at('14:00').toISOString(), null, exp('11:00', s.staffB))), 'another professional\'s appointment');
  assert.ok(await refused(() => rescheduleAppointmentAction(s.clientId, anas, at('14:00').toISOString(), s.staffB, exp('10:00', s.staffA))), 'moving own appointment to another column');
  assert.deepEqual(await rescheduleAppointmentAction(s.clientId, anas, at('14:00').toISOString(), null, exp('10:00', s.staffA)), { ok: true }, 'own appointment, own column');

  as(otherClientOwner);
  assert.ok(await refused(() => rescheduleAppointmentAction(s.clientId, anas, at('15:00').toISOString(), null, exp('14:00', s.staffA))), 'another client of the tenant');
  assert.ok(await refused(() => rescheduleAppointmentAction(s.otherClientId, anas, at('15:00').toISOString(), null, exp('14:00', s.staffA))), 'through its own client id');
  as(foreignOwner);
  assert.ok(await refused(() => rescheduleAppointmentAction(s.clientId, anas, at('15:00').toISOString(), null, exp('14:00', s.staffA))), 'another tenant');
  as(null);
  assert.ok(await refused(() => rescheduleAppointmentAction(s.clientId, anas, at('15:00').toISOString(), null, exp('14:00', s.staffA))), 'anonymous');

  assert.equal((await row(anas)).start_at.toISOString(), at('14:00').toISOString(), 'only the allowed move happened');
  assert.equal((await row(betos)).start_at.toISOString(), at('11:00').toISOString());
});
