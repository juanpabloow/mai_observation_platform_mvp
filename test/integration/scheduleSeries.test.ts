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
 * RECURRING SCHEDULE + RESCHEDULE + WALK-IN CONTACTS (migration 1819) — behavioural, through
 * the REAL server actions and the REAL availability loader on the local test database. Only
 * the session read and the Next request boundaries are stubbed (same harness as
 * timeOffPermissions.test.ts). Dates are computed from the real clock so "the past" is
 * genuinely in the past: every write here targets dates at least two days ahead.
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
const { rescheduleAppointmentAction, createManualAppointmentAction } = await import('../../web/lib/schedulingActions.js');
const { saveAppointmentContactAction } = await import('../../web/lib/appointmentContactActions.js');

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

test('a weekly-hours GAP becomes ONE usual break with an open start — availability is identical', async () => {
  const s = await scenario();
  const thu = nextWeekday(4);
  await query(`UPDATE staff SET working_hours = $2 WHERE id = $1`, [
    s.staffA,
    JSON.stringify({ thu: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] }),
  ]);
  const before = await freeStarts(s, s.staffA, thu);
  assert.ok(!before.includes('13:00') && !before.includes('13:30'), 'the gap is not bookable');
  asUser(s.owner);
  const r = await series.adoptLegacyBreakAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekday: 4, start: '13:00', end: '14:00' });
  assert.ok(r.ok, JSON.stringify(r));
  const after1 = await freeStarts(s, s.staffA, thu);
  assert.deepEqual(after1, before, 'same free times after the conversion');
  const rows = await query<{ starts_on: string | null; kind: string }>(`SELECT starts_on, kind FROM schedule_series WHERE staff_id = $1`, [s.staffA]);
  assert.deepEqual(rows.rows, [{ starts_on: null, kind: 'break' }], 'one break row, open start (the past reads as before)');
  const hours = await query<{ h: Record<string, unknown> }>(`SELECT working_hours AS h FROM staff WHERE id = $1`, [s.staffA]);
  assert.deepEqual(hours.rows[0].h, { thu: [{ start: '09:00', end: '18:00' }] }, 'the day is one span now');
});

test('PRIORITY CASE: move ONE Thursday lunch 13–14 → 14–15; reopen shows it; other Thursdays keep 13–14', async () => {
  const s = await scenario();
  const thu = nextWeekday(4);
  const thuNext = addDays(thu, 7);
  await query(`UPDATE staff SET working_hours = $2 WHERE id = $1`, [s.staffA, JSON.stringify({ thu: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '18:00' }] })]);
  asUser(s.owner);
  const adopted = await series.adoptLegacyBreakAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekday: 4, start: '13:00', end: '14:00' });
  assert.ok(adopted.ok);
  const seriesId = adopted.ok ? adopted.seriesId : '';
  // An appointment at 14:15 on THAT Thursday is affected; nothing is moved.
  const appt = await insertAppointment(s, s.staffA, at(thu, 14, 15));
  const dry = await series.editSeriesAction({ clientId: s.clientId, seriesId, date: thu, scope: 'date', start: '14:00', end: '15:00' });
  assert.ok(dry.ok && !dry.written, 'not written while an appointment is inside');
  assert.deepEqual(dry.ok ? dry.affected.map((a) => a.id) : [], [appt]);
  const saved = await series.editSeriesAction({ clientId: s.clientId, seriesId, date: thu, scope: 'date', start: '14:00', end: '15:00', confirm: true });
  assert.ok(saved.ok && saved.written, JSON.stringify(saved));
  // ONE break row and ONE override — never a second block.
  assert.equal((await query(`SELECT 1 FROM schedule_series WHERE staff_id = $1`, [s.staffA])).rowCount, 1);
  assert.equal((await query(`SELECT 1 FROM schedule_exceptions WHERE staff_id = $1`, [s.staffA])).rowCount, 0);
  const ov = await query<{ action: string; start_min: number }>(`SELECT action, start_min FROM schedule_series_overrides WHERE series_id = $1`, [seriesId]);
  assert.deepEqual(ov.rows, [{ action: 'move', start_min: 840 }]);
  // Availability: 13:00 free that day, 14:00–15:00 blocked; next Thursday as usual. Discounted once.
  const day = await freeStarts(s, s.staffA, thu);
  assert.ok(day.includes('13:00') && day.includes('13:30'), 'the usual lunch hour is bookable that day');
  assert.ok(!day.includes('14:00') && !day.includes('14:30'), 'the moved lunch is not');
  const week = await freeStarts(s, s.staffA, thuNext);
  assert.ok(!week.includes('13:00') && week.includes('14:00'), 'the next Thursday keeps 13–14');
  // Reopen: the occurrence carries its own values and an exception marker.
  const list = await series.listScheduleSeriesAction(s.clientId, s.siteId);
  assert.ok(list.ok);
  const v = list.ok ? list.series.find((x) => x.id === seriesId) : undefined;
  assert.deepEqual(v?.overrides, [{ date: thu, action: 'move', start: '14:00', end: '15:00' }]);
  // The appointment is untouched (status + time) — it now "requires review", derived.
  const a = await query<{ status: string; start_at: Date }>(`SELECT status, start_at FROM appointments WHERE id = $1`, [appt]);
  assert.equal(a.rows[0].status, 'confirmed');
  assert.equal(a.rows[0].start_at.getTime(), at(thu, 14, 15).getTime());
  // «Volver al horario habitual»: the exception goes away.
  const back = await series.editSeriesAction({ clientId: s.clientId, seriesId, date: thu, scope: 'date', start: '13:00', end: '14:00', confirm: true });
  assert.ok(back.ok && back.written);
  assert.equal((await query(`SELECT 1 FROM schedule_series_overrides WHERE series_id = $1`, [seriesId])).rowCount, 0);
});

test('recurring block: three edit scopes, the past kept, exclusions kept, moved dates adopt the new times', async () => {
  const s = await scenario();
  asUser(s.owner);
  const tue = nextWeekday(2, 9); // leaves a not-started Tuesday BEFORE it, inside the series
  const startsOn = addDays(tue, -7);
  const created = await series.createBlockSeriesAction({
    clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekdays: [2], allDay: false, start: '16:00', end: '17:00',
    startsOn, endKind: 'never', reason: 'Formación interna', confirm: true,
  });
  assert.ok(created.ok && created.written, JSON.stringify(created));
  const id = (await query<{ id: string }>(`SELECT id FROM schedule_series WHERE staff_id = $1`, [s.staffA])).rows[0].id;
  // Exclude a later date and move another one.
  const later = addDays(tue, 7);
  const later2 = addDays(tue, 14);
  assert.ok((await series.deleteSeriesAction({ clientId: s.clientId, seriesId: id, date: later, scope: 'date' })).ok);
  assert.ok((await series.editSeriesAction({ clientId: s.clientId, seriesId: id, date: later2, scope: 'date', start: '18:00', end: '19:00', confirm: true })).ok);
  // «Esta y las siguientes» from `tue`, 15–16.
  const r = await series.editSeriesAction({ clientId: s.clientId, seriesId: id, date: tue, scope: 'following', start: '15:00', end: '16:00', confirm: true });
  assert.ok(r.ok && r.written, JSON.stringify(r));
  const rows = await query<{ id: string; starts_on: string; ends_on: string | null; start_min: number }>(
    `SELECT id, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, start_min FROM schedule_series WHERE staff_id = $1 ORDER BY starts_on`,
    [s.staffA],
  );
  assert.equal(rows.rowCount, 2, 'split: earlier segment + continuation');
  assert.deepEqual([rows.rows[0].starts_on, rows.rows[0].ends_on, rows.rows[0].start_min], [startsOn, addDays(tue, -1), 960], 'earlier segment intact');
  assert.deepEqual([rows.rows[1].starts_on, rows.rows[1].ends_on, rows.rows[1].start_min], [tue, null, 900], 'continuation with the new times');
  const ov = await query<{ d: string; action: string }>(
    `SELECT to_char(occurrence_date,'YYYY-MM-DD') AS d, action FROM schedule_series_overrides WHERE series_id = $1 ORDER BY 1`,
    [rows.rows[1].id],
  );
  assert.deepEqual(ov.rows, [{ d: later, action: 'skip' }], 'the excluded date stays excluded; the moved one adopted the new times');
  // The earlier Tuesday still blocks 16–17; `later` blocks nothing; `later2` blocks 15–16.
  assert.ok(!(await freeStarts(s, s.staffA, startsOn)).includes('16:00'));
  assert.ok((await freeStarts(s, s.staffA, later)).includes('15:00'));
  const l2 = await freeStarts(s, s.staffA, later2);
  assert.ok(!l2.includes('15:00') && l2.includes('17:00'), 'the moved date adopted 15–16 (its old 18–19 is gone)');
  // «Toda la serie futura» cuts at the FIRST not-started occurrence — the earlier Tuesday.
  const f = await series.editSeriesAction({ clientId: s.clientId, seriesId: rows.rows[0].id, date: startsOn, scope: 'future', start: '10:00', end: '11:00', dryRun: true });
  assert.ok(f.ok && f.summary?.from === startsOn, 'future scope starts at the first open date');
  // Delete «esta y las siguientes» on the continuation: it is removed (nothing of it is past).
  const del = await series.deleteSeriesAction({ clientId: s.clientId, seriesId: rows.rows[1].id, date: tue, scope: 'following' });
  assert.ok(del.ok && del.written);
  assert.equal((await query(`SELECT 1 FROM schedule_series WHERE id = $1`, [rows.rows[1].id])).rowCount, 0);
  assert.equal((await query(`SELECT 1 FROM schedule_series WHERE id = $1`, [rows.rows[0].id])).rowCount, 1, 'history kept');
});

test('series end and repeat days bound what is blocked; a site series closes it for everyone, a staff one does not', async () => {
  const s = await scenario();
  asUser(s.owner);
  const mon = nextWeekday(1);
  const r = await series.createBlockSeriesAction({
    clientId: s.clientId, siteId: s.siteId, staffId: null, weekdays: [1, 3], allDay: false, start: '09:00', end: '12:00',
    startsOn: mon, endKind: 'after', count: 2, publicReason: 'site_closed', confirm: true,
  });
  assert.ok(r.ok && r.written, JSON.stringify(r));
  const wed = addDays(mon, 2);
  const mon2 = addDays(mon, 7);
  for (const st of [s.staffA, s.staffB]) {
    assert.ok(!(await freeStarts(s, st, mon)).includes('09:00'), 'Monday closed for everyone');
    assert.ok(!(await freeStarts(s, st, wed)).includes('09:00'), 'Wednesday too (2nd time)');
    assert.ok((await freeStarts(s, st, mon2)).includes('09:00'), 'after 2 times the series has ended');
  }
  const v = await series.createBlockSeriesAction({
    clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekdays: [5], allDay: true, startsOn: nextWeekday(5), endKind: 'never', publicReason: 'vacation', confirm: true,
  });
  assert.ok(v.ok);
  const fri = nextWeekday(5);
  assert.equal((await freeStarts(s, s.staffA, fri)).length, 0, 'Ana is away all day');
  assert.ok((await freeStarts(s, s.staffB, fri)).length > 0, "Ana's vacation does not close the site");
});

test('permissions + isolation: setter blocks a professional, not the site nor breaks; a staff login nothing; another business nothing', async () => {
  const s = await scenario();
  const tue = nextWeekday(2);
  asUser(s.setter);
  const ok = await series.createBlockSeriesAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, weekdays: [2], allDay: false, start: '10:00', end: '11:00', startsOn: tue, endKind: 'never', confirm: true });
  assert.ok(ok.ok, 'setter: agenda.block on a professional');
  const site = await series.createBlockSeriesAction({ clientId: s.clientId, siteId: s.siteId, staffId: null, weekdays: [2], allDay: false, start: '10:00', end: '11:00', startsOn: tue, endKind: 'never', confirm: true });
  assert.equal(site.ok, false, 'setter: no site closure (hours.manage)');
  const week = await series.saveWeeklyScheduleAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, days: Array(7).fill({ start: '09:00', end: '18:00' }), breaks: Array(7).fill([]), confirm: true });
  assert.equal(week.ok, false, "setter: no professional's weekly hours (team.manage)");
  // A staff login.
  const staffUser = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1,'S',$2,true)`, [staffUser, `s-${staffUser.slice(0, 6)}@t.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1,$2,'member',$3,'staff',$4,$5)`,
    [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
  );
  asUser(staffUser);
  const sid = (await query<{ id: string }>(`SELECT id FROM schedule_series WHERE staff_id = $1`, [s.staffA])).rows[0].id;
  assert.equal((await series.editSeriesAction({ clientId: s.clientId, seriesId: sid, date: tue, scope: 'date', start: '12:00', end: '13:00', confirm: true })).ok, false, 'staff login: refused');
  assert.equal((await series.deleteSeriesAction({ clientId: s.clientId, seriesId: sid, date: tue, scope: 'future' })).ok, false, 'staff login: refused');
  // Another business: the owner of a DIFFERENT tenant cannot reach this series.
  const other = await scenario();
  asUser(other.owner);
  assert.equal((await series.editSeriesAction({ clientId: other.clientId, seriesId: sid, date: tue, scope: 'date', start: '12:00', end: '13:00', confirm: true })).ok, false, 'cross-tenant: not found');
  assert.equal((await series.listScheduleSeriesAction(other.clientId, s.siteId)).ok, false, 'cross-tenant site: not found');
  await query(`DELETE FROM "user" WHERE id = $1`, [staffUser]);
});

test('reschedule moves the SAME appointment, re-checks availability, refuses a break and a just-taken slot', async () => {
  const s = await scenario();
  asUser(s.owner);
  const wed = nextWeekday(3);
  const appt = await insertAppointment(s, s.staffA, at(wed, 10, 0));
  const before = (await query<{ n: string }>(`SELECT count(*) AS n FROM appointments WHERE tenant_id = $1`, [s.tenantId])).rows[0].n;
  // Move to 11:00 — in place.
  const r = await rescheduleAppointmentAction(s.clientId, appt, at(wed, 11, 0).toISOString(), null, { startAt: at(wed, 10, 0).toISOString(), staffId: s.staffA });
  assert.ok(r.ok, JSON.stringify(r));
  const after1 = (await query<{ n: string }>(`SELECT count(*) AS n FROM appointments WHERE tenant_id = $1`, [s.tenantId])).rows[0].n;
  assert.equal(after1, before, 'no appointment created, none cancelled');
  const row = await query<{ start_at: Date; version: number; status: string }>(`SELECT start_at, version, status FROM appointments WHERE id = $1`, [appt]);
  assert.equal(row.rows[0].start_at.getTime(), at(wed, 11, 0).getTime());
  assert.equal(row.rows[0].status, 'confirmed', 'state kept');
  const ev = await query(`SELECT 1 FROM appointment_events WHERE appointment_id = $1 AND event_type = 'appointment_rescheduled'`, [appt]);
  assert.equal(ev.rowCount, 1, 'history records the move');
  // Into a usual break → refused by the server re-check.
  await series.saveWeeklyScheduleAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, days: [null, ...Array(6).fill({ start: '09:00', end: '18:00' })], breaks: [[], ...Array(6).fill([{ start: '13:00', end: '14:00' }])], confirm: true });
  const intoBreak = await rescheduleAppointmentAction(s.clientId, appt, at(wed, 13, 0).toISOString(), null, { startAt: at(wed, 11, 0).toISOString(), staffId: s.staffA });
  assert.equal(intoBreak.ok, false);
  // Two operators race for 15:00 (two different appointments): exactly one wins.
  const other = await insertAppointment(s, s.staffB, at(wed, 9, 0));
  const [a, b] = await Promise.all([
    rescheduleAppointmentAction(s.clientId, appt, at(wed, 15, 0).toISOString(), null, { startAt: at(wed, 11, 0).toISOString(), staffId: s.staffA }),
    rescheduleAppointmentAction(s.clientId, other, at(wed, 15, 0).toISOString(), s.staffA, { startAt: at(wed, 9, 0).toISOString(), staffId: s.staffB }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1, 'one wins, one is told the time was taken');
  const loser = a.ok ? b : a;
  assert.ok(!loser.ok && ['conflict_slot', 'unavailable'].includes(loser.code ?? ''), `the loser gets a slot code (${!loser.ok ? loser.code : ''})`);
  // A stale «Antes» (the appointment moved meanwhile) writes nothing.
  const stale = await rescheduleAppointmentAction(s.clientId, appt, at(wed, 16, 0).toISOString(), null, { startAt: at(wed, 10, 0).toISOString(), staffId: s.staffA });
  assert.equal(stale.ok, false);
});

test('walk-in: no contact unless asked; a NAME never merges people; a typed phone that exists is offered to LINK', async () => {
  const s = await scenario();
  asUser(s.owner);
  const sat = nextWeekday(6);
  const mk = (h: number, extra: Record<string, unknown>) =>
    createManualAppointmentAction(s.clientId, { siteId: s.siteId, serviceId: s.serviceBeard, staffId: s.staffA, startAt: at(sat, h).toISOString(), walkIn: true, idempotencyKey: randomUUID(), ...extra });
  const j1 = await mk(9, { customerName: 'Juan', contactMode: 'guest' });
  const j2 = await mk(10, { customerName: 'Juan' });
  assert.ok(j1.ok && j2.ok);
  const rows = await query<{ contact_id: string | null; guest_name: string | null }>(`SELECT contact_id, guest_name FROM appointments WHERE id = ANY($1::uuid[])`, [[j1.ok ? j1.id : '', j2.ok ? j2.id : '']]);
  assert.ok(rows.rows.every((r) => r.contact_id === null && r.guest_name === 'Juan'), 'two walk-ins named Juan: no contact, details kept');
  assert.equal((await query(`SELECT 1 FROM contacts WHERE tenant_id = $1`, [s.tenantId])).rowCount, 0, 'no contact was created from a name');
  // Saving a contact needs a valid phone or email.
  const bad = await mk(11, { customerName: 'Ana', contactMode: 'create' });
  assert.ok(!bad.ok && bad.fieldErrors?.phone, 'a contact needs a phone or an email');
  const okc = await mk(11, { customerName: 'Ana', customerPhone: '300 555 0101', contactMode: 'create' });
  assert.ok(okc.ok, JSON.stringify(okc));
  // The same phone again → offered to link, nothing created.
  const dup = await mk(12, { customerName: 'Ana B', customerPhone: '+57 300 555 0101', contactMode: 'create' });
  assert.ok(!dup.ok && (dup.matches?.length ?? 0) === 1, 'the existing contact is offered');
  assert.equal((await query(`SELECT 1 FROM contacts WHERE tenant_id = $1`, [s.tenantId])).rowCount, 1, 'no duplicate');
  // From the detail: link the guest appointment to the existing contact.
  const contactId = dup.ok ? '' : dup.matches?.[0].contactId ?? '';
  const link = await saveAppointmentContactAction(s.clientId, j1.ok ? j1.id : '', { mode: 'link', contactId });
  assert.ok(link.ok, JSON.stringify(link));
  const linked = await query<{ contact_id: string; guest_name: string | null }>(`SELECT contact_id, guest_name FROM appointments WHERE id = $1`, [j1.ok ? j1.id : '']);
  assert.equal(linked.rows[0].contact_id, contactId);
  assert.equal(linked.rows[0].guest_name, null, 'the typed details moved into the contact');
  // A link is never replaced; a contact of ANOTHER business is refused.
  assert.equal((await saveAppointmentContactAction(s.clientId, j1.ok ? j1.id : '', { mode: 'link', contactId })).ok, false);
  const foreign = await query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name) VALUES ($1,$2,'manual','x-foreign','Otro') RETURNING id`,
    [s.tenantId, s.otherClientId],
  );
  assert.equal((await saveAppointmentContactAction(s.clientId, j2.ok ? j2.id : '', { mode: 'link', contactId: foreign.rows[0].id })).ok, false, 'cross-business contact refused');
  // Guest details stay editable without a contact, an email alone creates one.
  const g = await saveAppointmentContactAction(s.clientId, j2.ok ? j2.id : '', { mode: 'guest', name: 'Juan Pérez', phone: '', email: 'juan@example.test' });
  assert.ok(g.ok);
  const kept = await query<{ guest_name: string; guest_email: string }>(`SELECT guest_name, guest_email FROM appointments WHERE id = $1`, [j2.ok ? j2.id : '']);
  assert.deepEqual(kept.rows[0], { guest_name: 'Juan Pérez', guest_email: 'juan@example.test' }, 'shown again on reopen');
  const c = await saveAppointmentContactAction(s.clientId, j2.ok ? j2.id : '', { mode: 'create', name: 'Juan Pérez', email: 'juan@example.test' });
  assert.ok(c.ok && c.contactId, 'email-only contact');
});
