import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { checkPastInterval, isRegisteredAfterService, type PastIntervalInput } from '../../src/scheduling/pastAttendance.js';
import { siteLocalToUtc } from '../../web/lib/siteCalendar.js';

// «Registrar atención realizada»: the exact interval against the professional's schedule that
// day — pure, the same reading of hours as the availability engine.
const TZ = 'America/Bogota'; // UTC-5, no DST
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-05:00`);
const MON = { mon: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '19:00' }] };
const base = (from: Date, until: Date, extra: Partial<PastIntervalInput> = {}): PastIntervalInput => ({
  timezone: TZ,
  siteHours: MON,
  staffHours: {},
  siteBreaks: [],
  staffBreaks: [],
  siteBlocks: [],
  staffBlocks: [],
  from,
  until,
  serviceEnd: until,
  now: at('2026-10-26', '13:00'),
  ...extra,
});

test('a real start off the 15-minute grid, a week ago, inside the hours: nothing in the way', () => {
  assert.deepEqual(checkPastInterval(base(at('2026-10-19', '10:07'), at('2026-10-19', '10:52'))), []);
});

test('a service that has not ended yet is not «ya realizada»', () => {
  const p = checkPastInterval(base(at('2026-10-26', '11:30'), at('2026-10-26', '12:15'), { now: at('2026-10-26', '12:00') }));
  assert.deepEqual(p.map((x) => x.code), ['not_ended']);
  assert.equal(p[0].from.getTime(), at('2026-10-26', '12:15').getTime(), 'says when it ends');
});

test('the site closed that weekday, outside its hours, across its lunch gap', () => {
  assert.deepEqual(checkPastInterval(base(at('2026-10-18', '10:00'), at('2026-10-18', '10:30'))).map((x) => x.code), ['site_closed_day'], 'Sunday');
  const lunch = checkPastInterval(base(at('2026-10-19', '12:45'), at('2026-10-19', '13:30')));
  assert.deepEqual(lunch.map((x) => x.code), ['outside_site_hours']);
  assert.equal(lunch[0].from.getTime(), at('2026-10-19', '13:00').getTime());
  assert.equal(lunch[0].until.getTime(), at('2026-10-19', '13:30').getTime());
});

test("outside the professional's own hours, a usual break, a site block, their own block", () => {
  const off = checkPastInterval(base(at('2026-10-19', '09:00'), at('2026-10-19', '09:45'), { staffHours: { mon: [{ start: '10:00', end: '18:00' }] } }));
  assert.deepEqual(off.map((x) => x.code), ['off_shift']);
  const brk = checkPastInterval(base(at('2026-10-19', '11:15'), at('2026-10-19', '12:00'), { staffBreaks: [{ from: at('2026-10-19', '11:30'), until: at('2026-10-19', '12:00') }] }));
  assert.deepEqual(brk.map((x) => x.code), ['break']);
  const closure = checkPastInterval(base(at('2026-10-19', '16:10'), at('2026-10-19', '16:40'), { siteBlocks: [{ from: at('2026-10-19', '16:00'), until: at('2026-10-19', '17:00') }] }));
  assert.deepEqual(closure.map((x) => x.code), ['site_closure']);
  const absence = checkPastInterval(base(at('2026-10-19', '16:10'), at('2026-10-19', '16:40'), { staffBlocks: [{ from: at('2026-10-19', '16:00'), until: at('2026-10-19', '17:00') }] }));
  assert.deepEqual(absence.map((x) => x.code), ['absence']);
  // A professional with no own hours inherits the site's — the engine's rule.
  assert.deepEqual(checkPastInterval(base(at('2026-10-19', '17:00'), at('2026-10-19', '17:45'))), []);
});

test('the site timezone, not the server one: 10:07 in Bogotá is 15:07 UTC', () => {
  assert.equal(siteLocalToUtc('2026-10-19', '10:07', TZ)?.toISOString(), '2026-10-19T15:07:00.000Z');
  assert.equal(siteLocalToUtc('2026-10-19', '10:07', 'Europe/Madrid')?.toISOString(), '2026-10-19T08:07:00.000Z');
  // Madrid leaves summer time on 25 Oct 2026 at 03:00 → 10:07 that day is UTC+1.
  assert.equal(siteLocalToUtc('2026-10-25', '10:07', 'Europe/Madrid')?.toISOString(), '2026-10-25T09:07:00.000Z');
  assert.equal(siteLocalToUtc('2026-10-19', '25:00', TZ), null);
  assert.equal(siteLocalToUtc('2026-10-19', '', TZ), null);
});

test('a back-dated registration is told apart from a walk-in registered when it happened', () => {
  const end = new Date('2026-10-19T15:45:00Z');
  assert.equal(isRegisteredAfterService({ origin: 'walk_in', created_at: new Date('2026-10-26T18:00:00Z'), service_end_at: end }), true);
  assert.equal(isRegisteredAfterService({ origin: 'walk_in', created_at: new Date('2026-10-19T15:00:00Z'), service_end_at: end }), false, '«ahora»');
  assert.equal(isRegisteredAfterService({ origin: 'internal', created_at: new Date('2026-10-26T18:00:00Z'), service_end_at: end }), false);
});
