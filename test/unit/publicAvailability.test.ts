import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { DayExplanation, ExplainCause } from '../../src/scheduling/availabilityExplain.js';
import { firstOpenDay, publicDaysForAny, publicDaysForArtist } from '../../web/lib/publicAvailability.js';
import { dayStatusOf, emptyDayCopy, groupSlots, revalidateSlot, type Selection } from '../../web/lib/publicBookingFlow.js';
import { servicePageDiagnosis } from '../../web/lib/bookingPage.js';

/**
 * Availability BY ARTIST on the public page: what a day says (site closed / this artist
 * away / no times left), "Sin preferencia" as a union of WHOLE slots, revalidation of a
 * chosen time, the time-of-day groups, and the "¿aparece en la página?" diagnosis.
 */

const ex = (staff_id: string, date: string, summary: DayExplanation['summary'], causes: ExplainCause[] = [], public_reason: DayExplanation['public_reason'] = null): DayExplanation => ({
  date,
  staff_id,
  status: summary === 'available' ? 'available' : 'unavailable',
  slot_count: summary === 'available' ? 3 : 0,
  summary,
  public_reason,
  causes,
});
const absenceAll: ExplainCause = { code: 'absence', coverage: 'all', minutes: 600, public_reason: 'vacation', covers_whole_working_day: true };
const absencePart: ExplainCause = { code: 'absence', coverage: 'part', minutes: 120, public_reason: null };
const closureAll: ExplainCause = { code: 'site_closure', coverage: 'all', minutes: 600, public_reason: 'site_closed', covers_whole_working_day: true };

test('one artist: away is the ARTIST, never the site; a partial absence is "no times left"', () => {
  const days = publicDaysForArtist(
    [
      ex('falla', '2026-10-19', 'absence', [absenceAll], 'vacation'),
      ex('falla', '2026-10-20', 'absence', [absencePart]),
      ex('falla', '2026-10-21', 'off_shift'),
      ex('falla', '2026-10-25', 'site_closed_day'),
      ex('falla', '2026-10-26', 'available'),
      ex('falla', '2026-10-27', 'booked'),
      ex('fede', '2026-10-19', 'available'),
    ],
    'falla',
  );
  assert.deepEqual(
    days.map((d) => [d.date.slice(5), d.kind, d.reason]),
    [
      ['10-19', 'artist_unavailable', 'vacation'],
      ['10-20', 'no_slots', null],
      ['10-21', 'artist_unavailable', null],
      ['10-25', 'site_closed', null],
      ['10-26', 'open', null],
      ['10-27', 'no_slots', null],
    ],
  );
});

test('Sin preferencia: open if ANY artist is open; closed only when the SITE is; all away = no times', () => {
  const both = ['falla', 'fede'];
  const days = publicDaysForAny(
    [
      ex('falla', '2026-10-19', 'absence', [absenceAll], 'vacation'),
      ex('fede', '2026-10-19', 'available'),
      ex('falla', '2026-10-20', 'absence', [absenceAll], 'vacation'),
      ex('fede', '2026-10-20', 'off_shift'),
      ex('falla', '2026-10-24', 'site_closure', [closureAll], 'site_closed'),
      ex('fede', '2026-10-24', 'site_closure', [closureAll], 'site_closed'),
      ex('falla', '2026-10-25', 'site_closed_day'),
      ex('fede', '2026-10-25', 'site_closed_day'),
      ex('hidden', '2026-10-26', 'available'),
    ],
    both,
  );
  assert.deepEqual(
    days.map((d) => [d.date.slice(5), d.kind, d.reason]),
    [
      ['10-19', 'open', null],
      ['10-20', 'no_slots', null],
      ['10-24', 'site_closed', 'site_closed'],
      ['10-25', 'site_closed', null],
    ],
    'a professional outside the list never opens a day',
  );
});

test('first open day per artist comes from the engine slots only', () => {
  const slots = [
    { start_at: '2026-10-19T15:00:00.000Z', available_staff_ids: ['fede'] },
    { start_at: '2026-10-26T15:00:00.000Z', available_staff_ids: ['falla', 'fede'] },
  ];
  const dayOf = (iso: string) => iso.slice(0, 10);
  assert.equal(firstOpenDay(slots, dayOf, 'falla'), '2026-10-26');
  assert.equal(firstOpenDay(slots, dayOf, 'fede'), '2026-10-19');
  assert.equal(firstOpenDay(slots, dayOf, null), '2026-10-19');
  assert.equal(firstOpenDay(slots, dayOf, 'nadie'), null);
});

test('calendar: the server kinds turn "full" into closed / away; weekday hours still win', () => {
  const kinds = new Map([
    ['2026-10-19', 'artist_unavailable' as const],
    ['2026-10-23', 'site_closed' as const],
  ]);
  const ctx = { today: '2026-10-15', lastDay: '2026-11-14', closedWeekdays: new Set(['sun']), load: 'loaded' as const, openDays: new Set(['2026-10-26']), kinds };
  assert.equal(dayStatusOf('2026-10-19', ctx), 'away');
  assert.equal(dayStatusOf('2026-10-23', ctx), 'closed');
  assert.equal(dayStatusOf('2026-10-21', ctx), 'full');
  assert.equal(dayStatusOf('2026-10-25', ctx), 'closed', 'Sunday: the site never opens');
  assert.equal(dayStatusOf('2026-10-26', ctx), 'open');
  assert.equal(dayStatusOf('2026-10-19', { ...ctx, kinds: undefined }), 'full', 'without kinds: the old behaviour');
});

test('empty day copy: three cases, neutral unless the reason was published', () => {
  const base = { siteName: 'Gallery', closedWeekday: false, othersHaveTimes: false };
  assert.equal(emptyDayCopy({ ...base, status: 'closed', artistName: 'Falla' }).title, 'La sede está cerrada este día');
  assert.equal(emptyDayCopy({ ...base, status: 'closed', artistName: null, closedWeekday: true }).title, 'Gallery no abre este día');
  assert.equal(emptyDayCopy({ ...base, status: 'away', artistName: 'Falla' }).title, 'Falla no tiene disponibilidad este día');
  assert.equal(emptyDayCopy({ ...base, status: 'away', artistName: 'Falla', reason: 'vacation' }).title, 'Falla está de vacaciones en esa fecha');
  assert.equal(emptyDayCopy({ ...base, status: 'full', artistName: 'Falla' }).title, 'No quedan horarios para este servicio este día');
  assert.match(emptyDayCopy({ ...base, status: 'away', artistName: 'Falla', othersHaveTimes: true }).text, /Otro artista sí tiene horarios/);
  assert.equal(emptyDayCopy({ ...base, status: 'full', artistName: null }).title, 'No quedan horarios para este servicio este día');
});

test('revalidation: a chosen time survives only if the engine still offers it for THIS choice', () => {
  const sel: Selection = { serviceId: 's', artist: 'fede', day: '2026-10-19', slotStart: '2026-10-19T15:00:00.000Z' };
  const dayOf = (iso: string) => iso.slice(0, 10);
  const still = [{ start_at: '2026-10-19T15:00:00.000Z', available_staff_ids: ['fede'] }];
  assert.deepEqual(revalidateSlot(sel, { month: '2026-10', slots: still }, dayOf), { sel, cleared: null });
  const onlyFalla = [{ start_at: '2026-10-19T15:00:00.000Z', available_staff_ids: ['falla'] }];
  assert.deepEqual(revalidateSlot(sel, { month: '2026-10', slots: onlyFalla }, dayOf), { sel: { ...sel, slotStart: null }, cleared: 'gone' }, 'another artist’s slot is not Federico’s');
  assert.equal(revalidateSlot({ ...sel, artist: 'any' }, { month: '2026-10', slots: onlyFalla }, dayOf).cleared, null, 'Sin preferencia: anyone counts');
  assert.equal(revalidateSlot(sel, { month: '2026-11', slots: [] }, dayOf).cleared, null, 'another month says nothing about it');
});

test('times: Mañana / Tarde / Noche in the site clock; every slot in exactly one group', () => {
  const tz = 'America/Bogota';
  const slots = ['14:00', '16:45', '17:00', '22:45', '23:00', '00:30'].map((t, i) => ({ start_at: `2026-10-${i === 5 ? '15' : '14'}T${t}:00.000Z` }));
  // 09:00, 11:45 → Mañana · 12:00, 17:45 → Tarde · 18:00, 19:30 → Noche
  const g = groupSlots(slots, tz);
  assert.deepEqual(g.map((x) => [x.name, x.items.length]), [['Mañana', 2], ['Tarde', 2], ['Noche', 2]]);
  assert.equal(g.reduce((n, x) => n + x.items.length, 0), slots.length);
});

test('diagnosis: listed / hidden by a setting / blocked by a missing requirement', () => {
  const artist = { name: 'Federico', active: true, takesBookings: true, performs: true };
  const site = { id: 's1', name: 'Gallery', active: true, enabled: true, artists: [artist] };
  const svc = { active: true, visible: true, description: 'x', includes: ['a'], imageUrl: 'https://x/y.jpg', price: '1', durationMin: 60 };
  assert.equal(servicePageDiagnosis({ service: svc, category: null, sites: [site] }).status, 'visible');
  assert.equal(servicePageDiagnosis({ service: { ...svc, visible: false }, category: null, sites: [site] }).status, 'hidden');
  assert.equal(servicePageDiagnosis({ service: svc, category: { name: 'Color', visible: true, layout: 'contact' }, sites: [site] }).status, 'hidden');
  assert.equal(servicePageDiagnosis({ service: svc, category: { name: 'Signature', visible: false, layout: 'list' }, sites: [site] }).status, 'hidden');
  const featured = servicePageDiagnosis({ service: { ...svc, imageUrl: null, includes: [] }, category: { name: 'Entre Nubes', visible: true, layout: 'featured' }, sites: [site] });
  assert.equal(featured.status, 'blocked');
  assert.match(featured.problems[0].message, /imagen, qué incluye/);
  const noArtist = servicePageDiagnosis({ service: svc, category: null, sites: [{ ...site, artists: [{ ...artist, performs: false }] }] });
  assert.deepEqual([noArtist.status, noArtist.problems.map((p) => [p.code, p.fix])], ['blocked', [['no_artist', 'staff']]]);
  const frontDesk = servicePageDiagnosis({ service: svc, category: null, sites: [{ ...site, artists: [{ ...artist, takesBookings: false }] }] });
  assert.deepEqual(frontDesk.problems.map((p) => p.code), ['artist_not_taking_bookings']);
  assert.deepEqual(servicePageDiagnosis({ service: svc, category: null, sites: [{ ...site, enabled: false }] }).problems.map((p) => p.code), ['no_site']);
  assert.equal(servicePageDiagnosis({ service: { ...svc, active: false }, category: null, sites: [site] }).status, 'blocked');
});

// ── Source-level: the page never lets an old answer win ─────────────────────────────

test('stale answers are dropped: every async availability write checks its request id', () => {
  const flow = readFileSync(fileURLToPath(new URL('../../web/components/booking/BookingFlow.tsx', import.meta.url)), 'utf8');
  for (const fn of ['const checkOthers = async', 'const loadNext = async']) {
    const body = flow.slice(flow.indexOf(fn), flow.indexOf('};', flow.indexOf(fn)));
    assert.ok(body.includes('id !== request.current'), `${fn} drops answers for an older choice`);
  }
  assert.ok(flow.includes('if (id !== request.current) return; // a newer month/service/artist won'));
  assert.ok(flow.includes('revalidateSlot('), 'a reloaded month revalidates the chosen time');
  assert.equal(/setSel\(\(cur\) =>[\s\S]{0,200}chosen =/.test(flow), false, 'no decision is read back from inside a state updater');
});
