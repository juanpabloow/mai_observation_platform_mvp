import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  inRosterFacet,
  presenceFor,
  presenceSegCounts,
  rosterFacetCounts,
  rosterOrder,
  rosterStatus,
  worksToday,
  type PresenceAppt,
  type PresenceSpan,
  type Weekly,
} from '../../web/components/scheduling/mobile/team/presence.js';

/**
 * AUDIT F1/S1 — the desktop/tablet roster (StaffTab) and the phone roster (TeamMobile)
 * must agree on who is on shift NOW. Desktop used to call "has hours today" "Disponible"
 * / "En turno", so after 22:30 in Bogotá it showed 3 on shift while the phone showed 0.
 * Both now derive from presence.ts; these cases pin the shared definition.
 *
 * Bogotá is UTC-5 all year (no DST), so 10:00 local = 15:00Z. 2026-10-09 is a Friday.
 */
const TZ = 'America/Bogota';
const DAY = '2026-10-09';
/** "HH:MM" Bogotá on DAY → ISO instant. Hours ≥ 19 roll into the next UTC day. */
const at = (hm: string) => new Date(Date.parse(`${DAY}T${hm}:00.000-05:00`)).toISOString();
const now = (hm: string) => Date.parse(at(hm));
const appt = (id: string, from: string, to: string, status = 'confirmed'): PresenceAppt => ({ id, startAt: at(from), endAt: at(to), status });
const span = (from: string, to: string): PresenceSpan => ({ startsAt: at(from), endsAt: at(to) });

const SITE: Weekly = {
  mon: [{ start: '09:00', end: '19:00' }],
  tue: [{ start: '09:00', end: '19:00' }],
  wed: [{ start: '09:00', end: '19:00' }],
  thu: [{ start: '09:00', end: '19:00' }],
  fri: [{ start: '09:00', end: '19:00' }],
  sat: [{ start: '09:00', end: '19:00' }],
  // Sunday: closed.
};

type Case = {
  workingHours?: Weekly;
  siteHours?: Weekly;
  appts?: PresenceAppt[];
  timeOff?: PresenceSpan[];
  closures?: PresenceSpan[];
  takesBookings?: boolean;
  now: number;
};

/** The same professional seen by both widths. */
function both(c: Case) {
  const input = {
    workingHours: c.workingHours ?? {},
    siteHours: c.siteHours ?? SITE,
    appts: c.appts ?? [],
    timeOff: c.timeOff ?? [],
    closures: c.closures ?? [],
    now: c.now,
    tz: TZ,
  };
  const phone = presenceFor({ ...input, active: true });
  const desk = rosterStatus({ ...input, takesBookings: c.takesBookings ?? true });
  // The invariant the audit asks for: one answer to "en turno ahora" at every width.
  assert.equal(desk.onShift, phone.onShift, 'desktop and phone disagree on "en turno"');
  return { phone, desk };
}

test('before the shift: works today, NOT on shift — on both widths', () => {
  const { phone, desk } = both({ now: now('07:00') });
  assert.equal(phone.onShift, false);
  assert.equal(phone.sub, 'Entra a las 09:00');
  assert.equal(desk.status, 'off_shift');
  assert.equal(desk.worksToday, true);
});

test('during the shift: on shift, "En turno" without bookings, "Disponible" with them', () => {
  const free = both({ now: now('10:00') });
  assert.equal(free.phone.kind, 'on');
  assert.equal(free.desk.status, 'on_shift');
  assert.equal(free.desk.onShift, true);

  const booked = both({ now: now('10:00'), appts: [appt('a', '12:00', '12:30')] });
  assert.equal(booked.desk.status, 'available');
  assert.equal(booked.desk.onShift, true);

  // A cancelled booking is not a booking.
  assert.equal(both({ now: now('10:00'), appts: [appt('a', '12:00', '12:30', 'cancelled')] }).desk.status, 'on_shift');
});

test('with a client in the chair: on shift on both widths', () => {
  const { phone, desk } = both({ now: now('10:40'), appts: [appt('a', '10:30', '11:15')] });
  assert.equal(phone.kind, 'busy');
  assert.equal(desk.status, 'with_client');
  assert.equal(desk.onShift, true);
});

test('after the shift (the audit case, 22:30 Bogotá): works today, NOT on shift', () => {
  const { phone, desk } = both({ now: now('22:30') });
  assert.equal(phone.onShift, false);
  assert.equal(phone.sub, 'Terminó a las 19:00');
  assert.equal(desk.status, 'off_shift');
  assert.equal(desk.worksToday, true);
});

test('a pause between two shifts is off shift, and says when they are back', () => {
  const split: Weekly = { fri: [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '19:00' }] };
  const lunch = both({ workingHours: split, now: now('14:00') });
  assert.equal(lunch.desk.status, 'off_shift');
  assert.equal(lunch.phone.sub, 'Entra a las 15:00');
  assert.equal(both({ workingHours: split, now: now('12:59') }).desk.onShift, true);
  // The end of a range is exclusive: 13:00 is already the pause.
  assert.equal(both({ workingHours: split, now: now('13:00') }).desk.onShift, false);
  assert.equal(both({ workingHours: split, now: now('15:00') }).desk.onShift, true);
});

test('no hours today: "Sin turno hoy" (does not work today), not "Fuera de turno"', () => {
  const { phone, desk } = both({ workingHours: { mon: [{ start: '09:00', end: '18:00' }] }, now: now('10:00') });
  assert.equal(phone.sub, 'No trabaja hoy');
  assert.equal(desk.status, 'off_today');
  assert.equal(desk.worksToday, false);
});

test('a closed weekday at the site: own hours that day do not count', () => {
  // 2026-10-11 is a Sunday; the site is closed on Sundays.
  const sunday = Date.parse('2026-10-11T10:00:00.000-05:00');
  const own: Weekly = { sun: [{ start: '09:00', end: '12:00' }] };
  const { phone, desk } = both({ workingHours: own, now: sunday });
  assert.equal(phone.onShift, false);
  assert.equal(desk.status, 'off_today');
  assert.equal(worksToday(own, SITE, sunday, TZ), false);
  // The site's hours inherited on a closed day: same answer.
  assert.equal(both({ now: sunday }).desk.status, 'off_today');
});

test('a site-wide closure covering now: works today, off shift, on both widths', () => {
  const { phone, desk } = both({ now: now('11:00'), closures: [span('10:00', '14:00')] });
  assert.equal(phone.sub, 'Sede cerrada hasta las 14:00');
  assert.equal(desk.status, 'off_shift');
  assert.equal(desk.worksToday, true);
});

test('time off covering now: "Ausente", off shift on both widths', () => {
  const { desk } = both({ now: now('11:00'), timeOff: [span('08:00', '18:00')] });
  assert.equal(desk.status, 'time_off');
  assert.equal(desk.onShift, false);
  assert.ok(desk.away);
});

test('the clock is the SITE timezone: 21:00 Friday in Bogotá is Saturday 02:00 UTC', () => {
  const late: Weekly = { fri: [{ start: '09:00', end: '23:00' }] };
  const site: Weekly = { fri: [{ start: '09:00', end: '23:00' }] };
  const t = now('21:00');
  assert.equal(new Date(t).getUTCDay(), 6, 'precondition: Saturday in UTC');
  const { desk } = both({ workingHours: late, siteHours: site, now: t });
  assert.equal(desk.status, 'on_shift');
  assert.equal(worksToday(late, site, t, TZ), true);
});

test('own hours are clipped to the site: hours past closing are not on shift', () => {
  const { desk, phone } = both({ workingHours: { fri: [{ start: '09:00', end: '21:00' }] }, now: now('20:00') });
  assert.equal(desk.status, 'off_shift');
  assert.equal(phone.sub, 'Terminó a las 19:00');
});

test('front desk (takes no bookings) keeps "Sin silla" but counts by its hours, like the phone', () => {
  assert.equal(both({ takesBookings: false, now: now('10:00') }).desk.status, 'no_chair');
  assert.equal(both({ takesBookings: false, now: now('10:00') }).desk.onShift, true);
  assert.equal(both({ takesBookings: false, now: now('22:30') }).desk.onShift, false);
});

test('facet pills: "En turno" includes a client in the chair, "Fuera" is the rest', () => {
  const roster = [
    both({ now: now('10:40'), appts: [appt('a', '10:30', '11:15')] }).desk, // with client
    both({ now: now('10:40') }).desk, // on shift
    both({ now: now('10:40'), workingHours: { mon: [{ start: '09:00', end: '18:00' }] } }).desk, // no hours today
    both({ now: now('10:40'), timeOff: [span('08:00', '18:00')] }).desk, // away
  ];
  assert.deepEqual(rosterFacetCounts(roster), { with_client: 1, available: 2, off_today: 2 });
  assert.equal(inRosterFacet(roster[0], 'available'), true);
  assert.equal(inRosterFacet(roster[2], 'off_today'), true);
});

test('the audit roster after closing: 0 on shift on every width (was 3 on desktop)', () => {
  // Three with Friday hours, one ("Marco") without — as in the sandbox.
  const t = now('22:35');
  const marco: Weekly = { mon: [{ start: '09:00', end: '19:00' }] };
  const roster = [{}, {}, {}, marco].map((workingHours) => both({ workingHours, now: t }).desk);
  assert.deepEqual(rosterFacetCounts(roster), { with_client: 0, available: 0, off_today: 4 });
  assert.deepEqual(
    roster.map((r) => r.status),
    ['off_shift', 'off_shift', 'off_shift', 'off_today'],
  );
});

test('StaffTab derives its status from the shared presence, not from "has hours today"', () => {
  const src = readFileSync(fileURLToPath(new URL('../../web/components/scheduling/staff/StaffTab.tsx', import.meta.url)), 'utf8');
  assert.match(src, /rosterStatus\(/);
  assert.match(src, /rosterFacetCounts\(/);
  assert.doesNotMatch(src, /workingHours\[todayKey\]/);
  assert.match(src, /off_shift: \{ label: "Fuera de turno"/);
});

// ── Inactive professionals (phase-1 follow-up): one roster, one count, every width ──

type Member = { id: string; active: boolean; takesBookings: boolean; workingHours: Weekly };

/** The professionals of one site as the page loads them: active AND inactive. */
const ROSTER: Member[] = [
  { id: 'daniela', active: true, takesBookings: true, workingHours: {} },
  { id: 'old-barber', active: false, takesBookings: true, workingHours: {} }, // inactive, would be "in hours"
  { id: 'federico', active: true, takesBookings: true, workingHours: {} },
  { id: 'marco', active: true, takesBookings: true, workingHours: { mon: [{ start: '09:00', end: '19:00' }] } },
  { id: 'paola', active: false, takesBookings: true, workingHours: { mon: [{ start: '09:00', end: '19:00' }] } },
];

/** Both widths over the same roster, at one instant. */
function widths(t: number, appts: Record<string, PresenceAppt[]> = {}) {
  const ordered = rosterOrder(ROSTER);
  const base = (m: Member) => ({
    workingHours: m.workingHours,
    siteHours: SITE,
    appts: appts[m.id] ?? [],
    timeOff: [],
    closures: [],
    now: t,
    tz: TZ,
  });
  const desk = ordered.map((m) => ({ id: m.id, ...rosterStatus({ ...base(m), active: m.active, takesBookings: m.takesBookings }) }));
  const phone = ordered.map((m) => ({ id: m.id, ...presenceFor({ ...base(m), active: m.active }) }));
  return { ordered, desk, phone };
}

test('inactive professionals are listed on BOTH widths, last, in the same order', () => {
  const { ordered, desk, phone } = widths(now('10:00'));
  assert.equal(ordered.length, ROSTER.length, 'nobody is dropped');
  assert.deepEqual(ordered.map((m) => m.id), ['daniela', 'federico', 'marco', 'old-barber', 'paola']);
  assert.deepEqual(desk.map((r) => r.id), phone.map((r) => r.id));
  assert.deepEqual(desk.slice(-2).map((r) => r.status), ['inactive', 'inactive']);
  assert.deepEqual(phone.slice(-2).map((r) => r.kind), ['inactive', 'inactive']);
  // Never "en turno", even inside the hours they would otherwise have.
  assert.ok(desk.slice(-2).every((r) => !r.onShift));
});

test('the counts agree across widths: Todos = En turno + Fuera, inactive in Todos and Fuera', () => {
  for (const [label, t] of [['during the shift', now('10:00')], ['after closing', now('22:30')]] as const) {
    const { desk, phone } = widths(t, { daniela: [appt('a', '09:30', '10:30')] });
    const pills = rosterFacetCounts(desk);
    const segs = presenceSegCounts(phone);
    const todos = desk.length; // StaffTab: `count: props.members.length`
    assert.equal(todos, segs.all, `${label}: Todos`);
    assert.equal(pills.available, segs.on, `${label}: En turno`);
    assert.equal(pills.off_today, segs.off, `${label}: Fuera`);
    assert.equal(pills.available + pills.off_today, todos, `${label}: the two buckets partition the roster`);
  }
  const during = rosterFacetCounts(widths(now('10:00'), { daniela: [appt('a', '09:30', '10:30')] }).desk);
  assert.deepEqual(during, { with_client: 1, available: 2, off_today: 3 }, 'Daniela with a client, Federico on shift; Marco + 2 inactive out');
});

test('the facet filters pick the same people on both widths', () => {
  const { desk, phone } = widths(now('10:00'));
  const deskOn = desk.filter((r) => inRosterFacet(r, 'available')).map((r) => r.id);
  const phoneOn = phone.filter((r) => r.onShift).map((r) => r.id);
  assert.deepEqual(deskOn, phoneOn);
  const deskOff = desk.filter((r) => inRosterFacet(r, 'off_today')).map((r) => r.id);
  const phoneOff = phone.filter((r) => !r.onShift).map((r) => r.id);
  assert.deepEqual(deskOff, phoneOff);
  assert.ok(deskOff.includes('old-barber') && deskOff.includes('paola'), 'inactive are findable under "Fuera"');
});

test('the desktop roster no longer filters inactive professionals out', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
  const ws = read('components/scheduling/staff/StaffWorkspace.tsx');
  assert.doesNotMatch(ws, /members\.filter\(\(m\) => m\.active\)/);
  const tab = read('components/scheduling/staff/StaffTab.tsx');
  assert.match(tab, /rosterOrder\(props\.members\)/);
  assert.match(tab, /active: s\.active,/);
  assert.match(tab, /inactive: \{ label: "Inactivo"/);
  assert.match(tab, /key: "all", label: "Todos", count: props\.members\.length/);
  const phone = read('components/scheduling/mobile/team/TeamMobile.tsx');
  assert.match(phone, /rosterOrder\(staff\.members\)/);
  assert.match(read('components/scheduling/mobile/team/TeamList.tsx'), /presenceSegCounts\(/);
});
