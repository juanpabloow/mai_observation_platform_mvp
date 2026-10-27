import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { mock } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { insertAppointment } from '../../src/db/repositories/scheduling/appointments.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, type Scenario } from './fixtures.js';

/**
 * JP-4 — EDITING an existing appointment end to end: the REAL server actions
 * (changeAppointmentServiceAction / correctAppointmentTimeAction) against PostgreSQL, only the
 * session read and Next's request boundaries stubbed (same pattern as rescheduleFlow.test.ts).
 *
 *  A — change the service: fits (end + price recomputed from the SAME start), refused on an
 *      overlap (named), a service the staff doesn't perform, a cancelled/no_show appointment, and
 *      a COMPLETED appointment with a recorded payment (→ void → re-charge). A completed
 *      appointment WITHOUT a payment may change (historical valor correction). A Staff login may
 *      NOT change the service of a completed appointment (D3); the Setter may.
 *  B — correct the time (and optionally the artist): allowed on PAST and COMPLETED appointments,
 *      no availability rule, duration preserved, status untouched. Refused on an overlap and on an
 *      artist change of a PAID appointment (D5); a time-only correction of a paid appointment is
 *      allowed (D2, the Setter too). A Staff login stays on its own column.
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

const { changeAppointmentServiceAction, correctAppointmentTimeAction } = await import('../../web/lib/schedulingActions.js');

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
async function owner(s: Scenario): Promise<string> {
  const id = await seedMember(s.tenantId, { role: 'owner' });
  users.push(id);
  return id;
}
async function setter(s: Scenario): Promise<string> {
  const id = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  users.push(id);
  return id;
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

async function appointment(s: Scenario, opts: { staffId?: string; serviceId?: string; start: string; durationMin: number; status?: string; price?: string | null }) {
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Cliente Sintético' });
  const start = at(opts.start);
  const end = new Date(start.getTime() + opts.durationMin * 60_000);
  const a = await withTransaction((c) =>
    insertAppointment(c, {
      tenantId: s.tenantId, clientId: s.clientId, siteId: s.siteId, contactId, sourceConversationId: null,
      staffId: opts.staffId ?? s.staffA, serviceId: opts.serviceId ?? s.serviceHaircut, startAt: start, serviceEndAt: end, blockedFrom: start, blockedUntil: end,
      serviceNameSnapshot: 'Corte (histórico)', durationMinSnapshot: opts.durationMin, priceSnapshot: opts.price ?? '45000',
      bufferBeforeMinSnapshot: 0, bufferAfterMinSnapshot: 0, origin: 'internal', createdByType: 'agent', createdByUserId: null, idempotencyKey: null,
    }),
  );
  if (opts.status && opts.status !== 'scheduled') await query(`UPDATE appointments SET status = $2 WHERE id = $1`, [a.id, opts.status]);
  return a.id;
}

async function payFor(s: Scenario, appointmentId: string, recordedBy: string) {
  await query(
    `INSERT INTO payments (tenant_id, client_id, appointment_id, method_key, total, recorded_by) VALUES ($1,$2,$3,'efectivo','45000.00',$4)`,
    [s.tenantId, s.clientId, appointmentId, recordedBy],
  );
}

const row = (id: string) =>
  query<{ id: string; status: string; staff_id: string; service_id: string; contact_id: string; service_name_snapshot: string; duration_min_snapshot: number; price_snapshot: string; start_at: Date; service_end_at: Date; version: number }>(
    `SELECT id, status, staff_id, service_id, contact_id, service_name_snapshot, duration_min_snapshot, price_snapshot::text AS price_snapshot, start_at, service_end_at, version FROM appointments WHERE id = $1`,
    [id],
  ).then((r) => r.rows[0]);
const apptEvents = (id: string, type: string) =>
  query<{ event_type: string; actor_user_id: string | null; detail: Record<string, { start_at?: string; staff_id?: string; name?: string }> & { reason?: string | null } }>(
    `SELECT event_type, actor_user_id, detail FROM appointment_events WHERE appointment_id = $1 AND event_type = $2 ORDER BY created_at`,
    [id, type],
  ).then((r) => r.rows);
/** A gate refusal shows up either as { ok:false } or as a thrown redirect()/notFound() (the
 *  cross-tenant / anonymous path, exactly as the mocked Next boundaries raise it). */
async function refused(fn: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await fn()).ok === false;
  } catch {
    return true;
  }
}
const feedPings = (s: Scenario, id: string) =>
  query<{ n: number }>(
    `SELECT count(*)::int AS n FROM scheduling_events WHERE tenant_id = $1 AND event_type = 'appointment.rescheduled' AND payload->>'appointment_id' = $2`,
    [s.tenantId, id],
  ).then((r) => r.rows[0].n);

// ───────────────────────────── A — change the service ─────────────────────────────

test('change service: the shorter service fits, end + price recomputed from the same start, history recorded', async () => {
  const s = await scenario();
  const o = await owner(s);
  as(o);
  const id = await appointment(s, { start: '10:00', durationMin: 60, price: '45000' });
  await query(`UPDATE appointments SET status = 'confirmed' WHERE id = $1`, [id]);
  const before = await row(id);

  const r = await changeAppointmentServiceAction(s.clientId, id, s.serviceBeard);
  assert.deepEqual(r, { ok: true });
  const after = await row(id);
  assert.equal(after.id, before.id);
  assert.equal(after.contact_id, before.contact_id, 'same client');
  assert.equal(after.service_id, s.serviceBeard);
  assert.equal(after.service_name_snapshot, 'Beard trim', 'the new service name is snapshotted');
  assert.equal(after.duration_min_snapshot, 30, 'the new duration');
  assert.equal(after.start_at.toISOString(), at('10:00').toISOString(), 'the start never moves');
  assert.equal(after.service_end_at.toISOString(), at('10:30').toISOString(), 'ends with the new 30-min duration');
  assert.equal(Number(after.price_snapshot), 15, 'price snapshot is the new service price');
  assert.equal(after.status, 'confirmed', 'status untouched');
  assert.equal(after.version, before.version + 1);
  const ev = await apptEvents(id, 'appointment_service_changed');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].actor_user_id, o, 'who');
  assert.equal(ev[0].detail.to.name, 'Beard trim');
  assert.equal(await feedPings(s, id), 1, 'the agenda feed is pinged to refresh');
  const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1`, [s.tenantId]);
  assert.equal(n.rows[0].n, 1, 'no second appointment was created');
});

test('change service: a longer service that overlaps the next booking is refused and names it; nothing is written', async () => {
  const s = await scenario();
  as(await owner(s));
  const id = await appointment(s, { start: '10:00', durationMin: 60 }); // ends 11:00
  await appointment(s, { start: '11:00', durationMin: 30, serviceId: s.serviceBeard }); // staffA booked 11:00–11:30
  const before = await row(id);

  // Haircut → Color (90 min) would run 10:00–11:30 and collide with the 11:00 booking.
  const r = await changeAppointmentServiceAction(s.clientId, id, s.serviceColor);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'unavailable');
  const after = await row(id);
  assert.equal(after.service_id, before.service_id, 'unchanged');
  assert.equal(after.version, before.version, 'nothing written');
  assert.equal((await apptEvents(id, 'appointment_service_changed')).length, 0);
});

test('change service: a service the assigned professional does not perform is refused', async () => {
  const s = await scenario();
  as(await owner(s));
  // Beto (staffB) does NOT perform Color.
  const id = await appointment(s, { start: '10:00', durationMin: 60, staffId: s.staffB });
  const r = await changeAppointmentServiceAction(s.clientId, id, s.serviceColor);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'service_not_performed');
  assert.equal((await row(id)).service_id, s.serviceHaircut, 'unchanged');
});

test('change service: a cancelled or no_show appointment cannot change its service', async () => {
  const s = await scenario();
  as(await owner(s));
  for (const status of ['cancelled', 'no_show']) {
    const id = await appointment(s, { start: '10:00', durationMin: 60, status });
    const r = await changeAppointmentServiceAction(s.clientId, id, s.serviceBeard);
    assert.equal(r.ok, false, status);
    assert.equal(r.ok ? '' : r.code, 'invalid_transition', status);
    assert.equal((await row(id)).service_id, s.serviceHaircut, `${status} unchanged`);
  }
});

test('change service: a COMPLETED appointment WITHOUT a payment may change (historical valor correction)', async () => {
  const s = await scenario();
  as(await owner(s));
  const id = await appointment(s, { start: '10:00', durationMin: 60, status: 'completed', price: '45000' });
  const r = await changeAppointmentServiceAction(s.clientId, id, s.serviceBeard);
  assert.deepEqual(r, { ok: true });
  const after = await row(id);
  assert.equal(after.status, 'completed', 'still completed');
  assert.equal(after.service_id, s.serviceBeard);
  assert.equal(Number(after.price_snapshot), 15, 'the completed valor follows the corrected service');
});

test('change service: a COMPLETED appointment WITH a recorded payment is blocked (void → re-charge)', async () => {
  const s = await scenario();
  const o = await owner(s);
  as(o);
  const id = await appointment(s, { start: '10:00', durationMin: 60, status: 'completed' });
  await payFor(s, id, o);
  const r = await changeAppointmentServiceAction(s.clientId, id, s.serviceBeard);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'payment_recorded');
  assert.equal((await row(id)).service_id, s.serviceHaircut, 'unchanged');
});

test('change service: a Staff login may change a live appointment but NOT a completed one (D3); the Setter may', async () => {
  const s = await scenario();
  const ana = await staffLogin(s, s.staffA);
  // Live, own column: allowed.
  const live = await appointment(s, { start: '10:00', durationMin: 60, staffId: s.staffA });
  as(ana);
  assert.deepEqual(await changeAppointmentServiceAction(s.clientId, live, s.serviceBeard), { ok: true });
  // Completed, own column: refused for the Staff login.
  const done = await appointment(s, { start: '12:00', durationMin: 60, staffId: s.staffA, status: 'completed' });
  const refusedStaff = await changeAppointmentServiceAction(s.clientId, done, s.serviceBeard);
  assert.equal(refusedStaff.ok, false, 'staff cannot change a completed service');
  assert.equal((await row(done)).service_id, s.serviceHaircut);
  // The Setter can.
  as(await setter(s));
  assert.deepEqual(await changeAppointmentServiceAction(s.clientId, done, s.serviceBeard), { ok: true });
  assert.equal((await row(done)).service_id, s.serviceBeard);
});

// ───────────────────────────── B — correct the time / artist ─────────────────────────────

test('correct time: a COMPLETED appointment can move to a PAST instant; duration preserved, status + pipeline untouched', async () => {
  const s = await scenario();
  const o = await owner(s);
  as(o);
  const id = await appointment(s, { start: '10:00', durationMin: 60, status: 'completed' });
  const before = await row(id);
  const past = new Date('2020-01-06T15:00:00.000Z'); // a Monday long gone — no availability rule applies

  const r = await correctAppointmentTimeAction(s.clientId, id, past.toISOString(), null, 'empezó antes de lo anotado');
  assert.deepEqual(r, { ok: true });
  const after = await row(id);
  assert.equal(after.status, 'completed', 'still completed — a correction never changes status');
  assert.equal(after.staff_id, before.staff_id, 'same professional');
  assert.equal(after.start_at.toISOString(), past.toISOString());
  assert.equal(after.service_end_at.toISOString(), new Date(past.getTime() + 60 * 60_000).toISOString(), 'duration preserved');
  assert.equal(after.service_id, before.service_id, 'service untouched');
  assert.equal(after.version, before.version + 1);
  const ev = await apptEvents(id, 'appointment_time_corrected');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].detail.reason, 'empezó antes de lo anotado');
  assert.equal(new Date(ev[0].detail.from.start_at!).toISOString(), before.start_at.toISOString());
  assert.equal(new Date(ev[0].detail.to.start_at!).toISOString(), past.toISOString());
  assert.equal(await feedPings(s, id), 1);
});

test('correct time: an overlap with another active appointment of the target professional is refused and names it', async () => {
  const s = await scenario();
  as(await owner(s));
  const id = await appointment(s, { start: '10:00', durationMin: 60 });
  await appointment(s, { start: '14:00', durationMin: 60 }); // staffA 14:00–15:00
  const before = await row(id);
  const r = await correctAppointmentTimeAction(s.clientId, id, at('14:30').toISOString(), null, null);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'unavailable');
  assert.equal((await row(id)).start_at.toISOString(), before.start_at.toISOString(), 'unchanged');
  assert.equal((await apptEvents(id, 'appointment_time_corrected')).length, 0);
});

test('correct the artist: allowed on an UNPAID appointment, recorded from → to', async () => {
  const s = await scenario();
  const o = await owner(s);
  as(o);
  const id = await appointment(s, { start: '10:00', durationMin: 60, staffId: s.staffA });
  const r = await correctAppointmentTimeAction(s.clientId, id, at('10:00').toISOString(), s.staffB, 'la atendió Beto');
  assert.deepEqual(r, { ok: true });
  assert.equal((await row(id)).staff_id, s.staffB);
  const ev = await apptEvents(id, 'appointment_time_corrected');
  assert.equal(ev[0].detail.from.staff_id, s.staffA);
  assert.equal(ev[0].detail.to.staff_id, s.staffB);
});

test('a PAID appointment: a time-only correction is allowed (money untouched), but changing the artist is blocked (D5)', async () => {
  const s = await scenario();
  const o = await owner(s);
  as(o);
  const id = await appointment(s, { start: '10:00', durationMin: 60, staffId: s.staffA, status: 'completed' });
  await payFor(s, id, o);

  // Time only (same staff): allowed — payment lines snapshot amounts, not time.
  const timeOnly = await correctAppointmentTimeAction(s.clientId, id, at('09:00').toISOString(), null, null);
  assert.deepEqual(timeOnly, { ok: true });
  assert.equal((await row(id)).start_at.toISOString(), at('09:00').toISOString());

  // Artist change: blocked (the payment snapshots the artist + commission).
  const artist = await correctAppointmentTimeAction(s.clientId, id, at('09:00').toISOString(), s.staffB, null);
  assert.equal(artist.ok, false);
  assert.equal(artist.ok ? '' : artist.code, 'payment_recorded');
  assert.equal((await row(id)).staff_id, s.staffA, 'artist unchanged');
});

test('correct time: the Setter may correct a completed appointment (D2)', async () => {
  const s = await scenario();
  await owner(s);
  const id = await appointment(s, { start: '10:00', durationMin: 60, status: 'completed' });
  as(await setter(s));
  const r = await correctAppointmentTimeAction(s.clientId, id, at('11:00').toISOString(), null, null);
  assert.deepEqual(r, { ok: true });
  assert.equal((await row(id)).start_at.toISOString(), at('11:00').toISOString());
});

test('correct time: a cancelled appointment cannot be corrected (it never happened)', async () => {
  const s = await scenario();
  as(await owner(s));
  const id = await appointment(s, { start: '10:00', durationMin: 60, status: 'cancelled' });
  const r = await correctAppointmentTimeAction(s.clientId, id, at('11:00').toISOString(), null, null);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? '' : r.code, 'invalid_transition');
});

test('permissions: a Staff login stays on its own column; other clients and tenants are refused', async () => {
  const s = await scenario();
  const other = await scenario();
  const ana = await staffLogin(s, s.staffA);
  const otherClientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  const foreignOwner = await seedMember(other.tenantId, { role: 'owner' });
  users.push(otherClientOwner, foreignOwner);
  const anas = await appointment(s, { start: '10:00', durationMin: 60, staffId: s.staffA });

  as(ana);
  // A staff login cannot move its appointment to ANOTHER professional's column.
  const toOther = await correctAppointmentTimeAction(s.clientId, anas, at('10:00').toISOString(), s.staffB, null);
  assert.equal(toOther.ok, false, 'staff cannot reassign to another column');
  assert.equal((await row(anas)).staff_id, s.staffA);
  // But a time-only correction on its own column is fine.
  assert.deepEqual(await correctAppointmentTimeAction(s.clientId, anas, at('11:00').toISOString(), null, null), { ok: true });

  as(otherClientOwner);
  assert.ok(await refused(() => correctAppointmentTimeAction(s.clientId, anas, at('12:00').toISOString(), null, null)), 'another client of the tenant');
  as(foreignOwner);
  assert.ok(await refused(() => correctAppointmentTimeAction(s.clientId, anas, at('12:00').toISOString(), null, null)), 'another tenant');
  as(null);
  assert.ok(await refused(() => correctAppointmentTimeAction(s.clientId, anas, at('12:00').toISOString(), null, null)), 'anonymous');
  assert.equal((await row(anas)).start_at.toISOString(), at('11:00').toISOString(), 'only the allowed correction happened');
});
