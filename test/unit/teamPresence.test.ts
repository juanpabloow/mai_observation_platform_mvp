import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  hoursDraftError,
  hoursEs,
  presenceFor,
  todayLoad,
  weekRows,
  workSpans,
  zonedClock,
  type PresenceAppt,
} from '../../web/components/scheduling/mobile/team/presence.js';

/**
 * BEHAVIOUR of the phone Equipo presence (web/components/scheduling/mobile/team/presence.ts):
 * "En turno / Con cliente / Fuera de turno / Inactivo" and the line beside the chip are all
 * DERIVED from working hours (site tz), appointments and exceptions. Bogotá is UTC-5 all
 * year, so 10:00 local = 15:00Z. 2026-10-09 is a Friday.
 */
const TZ = 'America/Bogota';
const DAY = '2026-10-09';
const at = (hm: string, day = DAY) => `${day}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00.000Z`;
const now = (hm: string) => Date.parse(at(hm));
const appt = (id: string, from: string, to: string, status = 'confirmed'): PresenceAppt => ({ id, startAt: at(from), endAt: at(to), status });
const SITE = { mon: [{ start: '09:00', end: '19:00' }], fri: [{ start: '09:00', end: '19:00' }] };
const base = { active: true, workingHours: {}, siteHours: SITE, appts: [] as PresenceAppt[], timeOff: [], closures: [], tz: TZ };

test('the site clock is the SITE timezone, not the server', () => {
  const c = zonedClock(now('10:30'), TZ);
  assert.equal(c.weekday, 'fri');
  assert.equal(c.minutes, 10 * 60 + 30);
  assert.equal(c.day, DAY);
});

test('no own hours inherits the site; own hours are intersected with the site', () => {
  assert.deepEqual(workSpans({}, SITE, 'fri'), [[540, 1140]]);
  assert.deepEqual(workSpans({ fri: [{ start: '08:00', end: '13:00' }, { start: '15:00', end: '21:00' }] }, SITE, 'fri'), [
    [540, 780],
    [900, 1140],
  ]);
  // Own hours on a day the site is closed: not working.
  assert.deepEqual(workSpans({ sun: [{ start: '09:00', end: '12:00' }] }, SITE, 'sun'), []);
});

test('on shift, with a next appointment → "Siguiente a las …"', () => {
  const p = presenceFor({ ...base, now: now('10:00'), appts: [appt('a', '10:30', '11:00')] });
  assert.equal(p.kind, 'on');
  assert.equal(p.onShift, true);
  assert.equal(p.chip, '● En turno');
  assert.equal(p.sub, 'Siguiente a las 10:30');
});

test('on shift, nothing left today → "Libre hasta las <end of shift>"', () => {
  const p = presenceFor({ ...base, now: now('16:00'), appts: [appt('a', '10:30', '11:00', 'completed')] });
  assert.equal(p.sub, 'Libre hasta las 19:00');
});

test('an appointment in progress → "Con cliente hasta …", counted as on shift', () => {
  const p = presenceFor({ ...base, now: now('10:40'), appts: [appt('a', '10:30', '11:15')] });
  assert.equal(p.kind, 'busy');
  assert.equal(p.chip, '◐ Con cliente');
  assert.equal(p.sub, 'Con cliente hasta 11:15');
  assert.equal(p.onShift, true);
  // A cancelled or no-show one is not a client in the chair.
  for (const status of ['cancelled', 'no_show']) {
    assert.equal(presenceFor({ ...base, now: now('10:40'), appts: [appt('a', '10:30', '11:15', status)] }).kind, 'on');
  }
});

test('outside hours → "Fuera de turno" with when they start / ended', () => {
  const early = presenceFor({ ...base, now: now('07:00') });
  assert.equal(early.kind, 'off');
  assert.equal(early.onShift, false);
  assert.equal(early.chip, '○ Fuera de turno');
  assert.equal(early.sub, 'Entra a las 09:00');
  assert.equal(presenceFor({ ...base, now: Date.parse('2026-10-10T01:00:00.000Z') /* 20:00 local */ }).sub, 'Terminó a las 19:00');
  assert.equal(presenceFor({ ...base, now: now('10:00'), workingHours: { mon: [{ start: '09:00', end: '18:00' }] } }).sub, 'No trabaja hoy');
});

test('time off and site closures put a professional off shift', () => {
  const off = presenceFor({ ...base, now: now('10:00'), timeOff: [{ startsAt: at('08:00'), endsAt: at('13:00') }] });
  assert.equal(off.kind, 'off');
  assert.equal(off.sub, 'Ausencia hasta las 13:00');
  const closed = presenceFor({ ...base, now: now('10:00'), closures: [{ startsAt: at('09:00'), endsAt: at('12:00') }] });
  assert.equal(closed.sub, 'Sede cerrada hasta las 12:00');
});

test('inactive professionals stay listed, labelled, never on shift', () => {
  const p = presenceFor({ ...base, active: false, now: now('10:00') });
  assert.equal(p.kind, 'inactive');
  assert.equal(p.chip, '⊘ Inactivo');
  assert.equal(p.onShift, false);
});

test('today\'s load: cancelled appointments do not count; Spanish decimal hours', () => {
  const load = todayLoad([appt('a', '09:00', '09:45'), appt('b', '10:00', '11:00'), appt('c', '12:00', '12:30', 'cancelled'), appt('d', '13:00', '13:33')]);
  assert.equal(load.count, 3);
  assert.equal(load.label, '3 citas hoy · 2,3 h');
  assert.equal(todayLoad([appt('a', '09:00', '10:00')]).label, '1 cita hoy · 1 h');
  assert.equal(todayLoad([]).label, 'Sin citas hoy');
  assert.equal(hoursEs(90), '1,5 h');
});

test('the weekly grid reads Monday first, split shifts joined, empty days "Libre"', () => {
  const rows = weekRows({ mon: [{ start: '15:00', end: '19:00' }, { start: '09:00', end: '13:00' }] });
  assert.equal(rows[0].day, 'Lunes');
  assert.equal(rows[0].value, '09:00 – 13:00, 15:00 – 19:00');
  assert.equal(rows[6].day, 'Domingo');
  assert.equal(rows[6].value, 'Libre');
});

test('an hours draft must be real ordered ranges before it can be saved', () => {
  assert.equal(hoursDraftError({ mon: [{ start: '09:00', end: '18:00' }] }), null);
  assert.match(hoursDraftError({ tue: [{ start: '18:00', end: '09:00' }] }) ?? '', /^Martes: la hora de fin/);
  assert.match(hoursDraftError({ wed: [{ start: '', end: '09:00' }] }) ?? '', /^Miércoles: completa/);
});

// ── Wiring (source level): the phone tree is additive and keeps the server's rules ──
const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('phone Equipo is its own md:hidden tree; both rosters get the same members', () => {
  const ws = web('components/scheduling/staff/StaffWorkspace.tsx');
  assert.ok(ws.includes('<TeamMobile'), 'the workspace renders the phone tree');
  assert.ok(ws.includes('hidden md:flex'), 'and hides the desktop tree below md');
  // Phase-1 follow-up: the desktop no longer drops inactive professionals silently — both
  // trees list and count the same roster (staffPresenceParity.test.ts).
  assert.ok(!ws.includes('members.filter((m) => m.active)'), 'the desktop roster is not filtered to ACTIVE staff');
  assert.ok(web('components/scheduling/mobile/team/TeamMobile.tsx').includes('md:hidden'), 'the phone tree never shows on tablet/desktop');
  // The phone detail is `?p=`, never the desktop drawer's `?s=` (whose focus trap would
  // mount hidden and swallow Escape).
  assert.ok(web('components/scheduling/mobile/team/TeamMobile.tsx').includes('p.set("p", id)'));
});

test('phone Equipo writes only through the existing, server-checked actions', () => {
  const files = ['TeamMember.tsx', 'forms.tsx'].map((f) => web(`components/scheduling/mobile/team/${f}`)).join('\n');
  for (const fn of [
    'createStaffAction',
    'updateStaffAction',
    'setStaffServiceAction',
    'addStaffCertificationAction',
    'deleteStaffCertificationAction',
    'deactivateStaffAction',
    'activateStaffAction',
    'countUpcomingAppointmentsAction',
  ]) {
    assert.ok(files.includes(fn), `uses ${fn}`);
  }
  assert.ok(!/from "@worker\//.test(files), 'no repository is reached from the client');
  // Deactivation asks first, with the upcoming-appointment count, safe option focused.
  const member = web('components/scheduling/mobile/team/TeamMember.tsx');
  assert.ok(member.includes('countUpcomingAppointmentsAction(clientId, "staff", member.id)'));
  assert.ok(/<MButton data-autofocus onClick=\{\(\) => setLayer\(null\)\}>\s*Cancelar/.test(member), 'Cancelar is first and takes focus');
});

test('the staff page still reads PII only behind the admin gate, scoped to the site and client', () => {
  const page = web('app/clients/[clientId]/scheduling/staff/page.tsx');
  assert.ok(page.includes('canManageClient(scope, clientId)'));
  assert.ok(page.includes('listStaffAdmin(tenantId, { siteId: site.id, clientId, includeInactive: true })'));
  assert.ok(page.includes('listAppointments(tenantId, { siteId: site.id, clientId, from: dayStart, to: dayEnd })'));
});
