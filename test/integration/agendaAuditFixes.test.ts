import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { addDays, localToday, weekdayOf } from '../../src/scheduling/series.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * AUDIT REGRESSIONS (agenda redesign) — each test pins one finding, through the REAL server
 * actions on the local test database (same harness as scheduleSeries.test.ts):
 *   A. "Completar" is refused before the appointment starts — on the server, for every
 *      agenda caller (desktop and phone share the action); the exact start is allowed.
 *   D. A change's conflicts respect its scope: «Solo esta fecha» never counts other dates,
 *      a series' end bounds the reach, and conflicts that already existed are reported
 *      apart from the ones the edit causes.
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

const series = await import('../../web/lib/scheduleSeriesActions.js');
const { completeAppointmentAction } = await import('../../web/lib/schedulingActions.js');
const { transitionStatus } = await import('../../src/scheduling/booking.js');

const TZ = 'America/Bogota';
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

/** The next local date with weekday `wd` that is at least `minAhead` days away. */
function nextWeekday(wd: number, minAhead = 2): string {
  let d = addDays(localToday(new Date(), TZ), minAhead);
  while (weekdayOf(d) !== wd) d = addDays(d, 1);
  return d;
}
const at = (date: string, hh: number, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return zonedPartsToUtc(y, m, d, hh, mm, TZ);
};
const hm = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);

async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  return { ...s, owner, setter };
}

/** Free starts of a professional for the 30-min service on one local date. */
async function freeStarts(s: { tenantId: string; siteId: string; serviceBeard: string }, staffId: string, date: string): Promise<string[]> {
  const r = await loadAvailability({
    tenantId: s.tenantId,
    siteId: s.siteId,
    serviceId: s.serviceBeard,
    staffId,
    from: at(date, 0),
    to: at(addDays(date, 1), 0),
    now: new Date(),
  });
  return (r?.slots ?? []).map((x) => hm(x.start_at));
}

async function insertAppointment(s: { tenantId: string; clientId: string; siteId: string; serviceBeard: string }, staffId: string, start: Date, mins = 30): Promise<string> {
  const end = new Date(start.getTime() + mins * 60_000);
  const r = await query<{ id: string }>(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, start_at, service_end_at, blocked_from, blocked_until,
       service_name_snapshot, duration_min_snapshot, status, origin, created_by_type)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$6,$7,'Beard trim',$8,'confirmed','internal','agent') RETURNING id`,
    [s.tenantId, s.clientId, s.siteId, staffId, s.serviceBeard, start, end, mins],
  );
  return r.rows[0].id;
}


const statusOf = async (id: string) => (await query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [id])).rows[0].status;

test('A · Completar waits for the start: a future appointment is refused, a started one completes', async () => {
  const s = await scenario();
  asUser(s.owner);
  const future = await insertAppointment(s, s.staffA, new Date(Date.now() + 2 * 3_600_000));
  const r = await completeAppointmentAction(s.clientId, future);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.error, /cuando la cita empiece/);
  assert.equal(await statusOf(future), 'confirmed', 'nothing changed');
  assert.equal((await query(`SELECT 1 FROM appointment_events WHERE appointment_id = $1 AND event_type = 'appointment_completed'`, [future])).rowCount, 0, 'no event');
  const started = await insertAppointment(s, s.staffA, new Date(Date.now() - 10 * 60_000));
  const ok = await completeAppointmentAction(s.clientId, started);
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(await statusOf(started), 'completed');
});

test('A · the exact start is allowed, one millisecond before is not (engine clock)', async () => {
  const s = await scenario();
  const start = new Date(Date.now() + 3 * 3_600_000);
  const id = await insertAppointment(s, s.staffA, start);
  const base = { tenantId: s.tenantId, appointmentId: id, actorType: 'agent' as const, scopeClientId: s.clientId, requireStartedToComplete: true };
  const early = await transitionStatus('completed', { ...base, now: new Date(start.getTime() - 1) });
  assert.deepEqual(early.ok ? 'ok' : early.error, 'not_started');
  assert.equal(await statusOf(id), 'confirmed');
  const exact = await transitionStatus('completed', { ...base, now: start });
  assert.ok(exact.ok, 'at the exact start');
  assert.equal(await statusOf(id), 'completed');
  // Other transitions are not gated by the start: a future appointment can still be confirmed/cancelled.
  const other = await insertAppointment(s, s.staffA, new Date(start.getTime() + 3_600_000));
  const cancel = await transitionStatus('cancelled', { ...base, appointmentId: other, now: new Date() });
  assert.ok(cancel.ok);
});

test("D · «Solo esta fecha» counts only that date; earlier conflicts are listed apart, never as caused", async () => {
  const s = await scenario();
  const thu = nextWeekday(4);
  const thuNext = addDays(thu, 7);
  await query(`UPDATE staff SET working_hours = $2 WHERE id = $1`, [s.staffA, JSON.stringify({ thu: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] })]);
  asUser(s.owner);
  const adopted = await series.adoptLegacyBreakAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekday: 4, start: '13:00', end: '14:00' });
  assert.ok(adopted.ok);
  const seriesId = adopted.ok ? adopted.seriesId : '';
  // That Thursday: one at 14:30 (the moved lunch takes it), one at 13:30–14:30 (inside the
  // lunch before AND after: pre-existing), one at 13:00–13:30 (freed by the move).
  const caused = await insertAppointment(s, s.staffA, at(thu, 14, 30));
  const both = await insertAppointment(s, s.staffA, at(thu, 13, 30), 60);
  const freed = await insertAppointment(s, s.staffA, at(thu, 13, 0));
  // NEXT Thursday: one inside its unchanged 13–14 lunch — another date, not this change.
  const otherDate = await insertAppointment(s, s.staffA, at(thuNext, 13, 0));
  const dry = await series.editSeriesAction({ clientId: s.clientId, seriesId, date: thu, scope: 'date', start: '14:00', end: '15:00', dryRun: true });
  assert.ok(dry.ok && !dry.written, JSON.stringify(dry));
  const ids = (l: Array<{ id: string }>) => l.map((a) => a.id).sort();
  assert.deepEqual(dry.ok ? ids(dry.affected) : [], [caused], 'only the conflict this edit creates');
  assert.deepEqual(dry.ok ? ids(dry.preexisting) : [], [both], 'the one already inside the lunch is shown apart');
  for (const id of [freed, otherDate]) {
    assert.ok(dry.ok && !dry.affected.some((a) => a.id === id) && !dry.preexisting.some((a) => a.id === id), 'neither the freed one nor another date');
  }
  // Nothing caused → it saves without confirmation (a pre-existing conflict never asks).
  const onlyPre = await series.editSeriesAction({ clientId: s.clientId, seriesId, date: thuNext, scope: 'date', start: '13:00', end: '13:45' });
  assert.ok(onlyPre.ok && onlyPre.written, 'shrinking next Thursday saves directly');
  assert.deepEqual(onlyPre.ok ? ids(onlyPre.preexisting) : [], [otherDate]);
});

test('D · a series end bounds the reach; «Esta y las siguientes» counts only what the edit adds', async () => {
  const s = await scenario();
  asUser(s.owner);
  const mon1 = nextWeekday(1, 3);
  const mon2 = addDays(mon1, 7);
  const mon3 = addDays(mon1, 14);
  const created = await series.createBlockSeriesAction({
    clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekdays: [1], allDay: false, start: '10:00', end: '11:00',
    startsOn: mon1, endKind: 'on', endsOn: mon2, reason: 'Formación', confirm: true,
  });
  assert.ok(created.ok && created.written, JSON.stringify(created));
  const id = (await query<{ id: string }>(`SELECT id FROM schedule_series WHERE staff_id = $1`, [s.staffA])).rows[0].id;
  const inside = await insertAppointment(s, s.staffA, at(mon2, 10, 30)); // inside before and after
  const added = await insertAppointment(s, s.staffA, at(mon2, 11, 0)); // only inside 10:30–11:30
  const afterEnd = await insertAppointment(s, s.staffA, at(mon3, 11, 0)); // past the series' end
  const dry = await series.editSeriesAction({ clientId: s.clientId, seriesId: id, date: mon1, scope: 'following', start: '10:30', end: '11:30', dryRun: true });
  assert.ok(dry.ok, JSON.stringify(dry));
  assert.deepEqual(dry.ok ? dry.affected.map((a) => a.id) : [], [added]);
  assert.deepEqual(dry.ok ? dry.preexisting.map((a) => a.id) : [], [inside]);
  assert.ok(dry.ok && ![...dry.affected, ...dry.preexisting].some((a) => a.id === afterEnd), 'after the series ends nothing is counted');
  // A new block counts everything inside it (there was nothing before) — and stops at its end too.
  const fresh = await series.createBlockSeriesAction({
    clientId: s.clientId, siteId: s.siteId, staffId: s.staffB, weekdays: [1], allDay: false, start: '10:00', end: '12:00',
    startsOn: mon1, endKind: 'on', endsOn: mon1, reason: 'Una vez', dryRun: true,
  });
  assert.ok(fresh.ok);
  const b2 = await insertAppointment(s, s.staffB, at(mon2, 10, 0));
  const fresh2 = await series.createBlockSeriesAction({
    clientId: s.clientId, siteId: s.siteId, staffId: s.staffB, weekdays: [1], allDay: false, start: '10:00', end: '12:00',
    startsOn: mon1, endKind: 'on', endsOn: mon1, reason: 'Una vez', dryRun: true,
  });
  assert.ok(fresh2.ok && !fresh2.affected.some((a) => a.id === b2), 'mon2 is after that block ends');
});
