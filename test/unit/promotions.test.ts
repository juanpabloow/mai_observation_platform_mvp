import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  appointmentReasons,
  appointmentRuleText,
  benefitPending,
  canMove,
  checkEligibility,
  isOnOffer,
  publishProblems,
  type PromotionRules,
} from '../../src/scheduling/promotions.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';

/**
 * PROMOTIONS — the shared rules (src/scheduling/promotions.ts). The 2×1 universitario's
 * CONFIRMED rule: bookable any day; the APPOINTMENT must be on a Monday or Tuesday in the
 * SITE's timezone; visible on a Wednesday; an ad link changes nothing.
 */

const TZ = 'America/Bogota';
// 2026-10-19 is a Monday.
const bog = (d: number, h: number, m = 0) => zonedPartsToUtc(2026, 10, d, h, m, TZ);

const twoForOne = (over: Partial<PromotionRules> = {}): PromotionRules => ({
  status: 'published',
  benefit_type: 'two_for_one',
  benefit_params: {},
  site_id: null,
  service_ids: ['corte'],
  staff_ids: [],
  bookable_from: null,
  bookable_until: null,
  appointment_weekdays: [1, 2],
  appointment_from: null,
  appointment_until: null,
  appointment_time_from: null,
  appointment_time_until: null,
  ...over,
});

test('2×1: Monday and Tuesday APPOINTMENTS qualify, every other day does not — in the site timezone', () => {
  const p = twoForOne();
  assert.deepEqual(appointmentReasons(p, bog(19, 10), TZ), [], 'Monday');
  assert.deepEqual(appointmentReasons(p, bog(20, 19, 30), TZ), [], 'Tuesday evening');
  for (const d of [21, 22, 23, 24, 25]) assert.deepEqual(appointmentReasons(p, bog(d, 10), TZ), ['weekday'], `Oct ${d}`);
  // Tuesday 23:30 in Bogotá is already WEDNESDAY 04:30 UTC — still Tuesday for the rule.
  const lateTuesday = bog(20, 23, 30);
  assert.equal(lateTuesday.getUTCDay(), 3);
  assert.deepEqual(appointmentReasons(p, lateTuesday, TZ), []);
  // Monday 00:30 UTC is still SUNDAY evening in Bogotá — not eligible.
  const utcMonday = new Date(Date.UTC(2026, 9, 19, 0, 30));
  assert.equal(utcMonday.getUTCDay(), 1);
  assert.deepEqual(appointmentReasons(p, utcMonday, TZ), ['weekday']);
});

test('A vs B: the promotion is on offer on a Wednesday; only a Wednesday APPOINTMENT is out', () => {
  const p = twoForOne();
  const wednesday = bog(21, 12);
  assert.equal(isOnOffer(p, wednesday), true, 'shown while browsing on a Wednesday');
  const booking = (startAt: Date) => checkEligibility(p, { now: wednesday, startAt, timeZone: TZ, siteId: 's', serviceId: 'corte', staffId: null });
  assert.equal(booking(bog(26, 10)).reasons.includes('weekday'), false, 'booked on Wednesday for next Monday: day OK');
  assert.equal(booking(bog(28, 10)).reasons.includes('weekday'), true, 'Wednesday appointment: not eligible');
});

test('window A: draft/paused/archived are never on offer; dates bound the booking moment', () => {
  const now = bog(21, 12);
  for (const status of ['draft', 'paused', 'archived'] as const) assert.equal(isOnOffer(twoForOne({ status }), now), false, status);
  assert.equal(isOnOffer(twoForOne({ bookable_from: bog(22, 0) }), now), false, 'not yet');
  assert.equal(isOnOffer(twoForOne({ bookable_until: bog(21, 12) }), now), false, 'until is exclusive');
  assert.equal(isOnOffer(twoForOne({ bookable_from: bog(1, 0), bookable_until: bog(31, 0) }), now), true);
});

test('B also bounds dates and hours, in the site clock', () => {
  const p = twoForOne({ appointment_weekdays: null, appointment_from: '2026-10-20', appointment_until: '2026-10-31', appointment_time_from: '10:00', appointment_time_until: '14:00' });
  assert.deepEqual(appointmentReasons(p, bog(19, 11), TZ), ['date_range']);
  assert.deepEqual(appointmentReasons(p, bog(20, 9, 30), TZ), ['time_range']);
  assert.deepEqual(appointmentReasons(p, bog(20, 14), TZ), ['time_range'], 'the end hour is exclusive');
  assert.deepEqual(appointmentReasons(p, bog(31, 13, 30), TZ), []);
});

test('scope: service, artist and site must match; an ad link has no say', () => {
  const p = twoForOne({ site_id: 'site-a', staff_ids: ['ana'] });
  const r = checkEligibility(p, { now: bog(19, 8), startAt: bog(19, 10), timeZone: TZ, siteId: 'site-b', serviceId: 'barba', staffId: null });
  for (const reason of ['other_site', 'service_not_included', 'staff_not_included'] as const) assert.ok(r.reasons.includes(reason), reason);
  // There is no parameter for "arrived from an ad": the signature itself enforces it.
  assert.equal(checkEligibility.length, 2);
});

test('the 2×1 can be drafted but never published or applied until its booking rules exist', () => {
  assert.ok(benefitPending('two_for_one', {}).length >= 5);
  const problems = publishProblems({ ...twoForOne({ status: 'draft' }), name: '2×1 universitario' });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /El 2×1 todavía no se puede reservar: falta definir .*dos personas/);
  const ok = checkEligibility(twoForOne(), { now: bog(19, 8), startAt: bog(19, 10), timeZone: TZ, siteId: 's', serviceId: 'corte', staffId: null });
  assert.deepEqual(ok, { eligible: false, reasons: ['benefit_not_bookable'] }, 'every other rule passes — still not applied');
  assert.ok(publishProblems({ ...twoForOne({ service_ids: [] }), name: ' ' }).includes('Elige al menos un servicio incluido.'));
});

test('status moves: draft → published ⇄ paused → archived (terminal)', () => {
  assert.equal(canMove('draft', 'published'), true);
  assert.equal(canMove('published', 'paused'), true);
  assert.equal(canMove('paused', 'published'), true);
  assert.equal(canMove('draft', 'paused'), false);
  for (const to of ['draft', 'published', 'paused'] as const) assert.equal(canMove('archived', to), false);
});

test('the visible rule text is generated from the rule', () => {
  assert.equal(appointmentRuleText(twoForOne()), 'Disponible para citas los lunes y martes');
  assert.equal(appointmentRuleText(twoForOne({ appointment_weekdays: [5, 1, 3] })), 'Disponible para citas los lunes, miércoles y viernes');
  assert.equal(appointmentRuleText(twoForOne({ appointment_weekdays: [6], appointment_time_from: '10:00', appointment_time_until: '13:00' })), 'Disponible para citas los sábados de 10:00 a 13:00');
  assert.equal(appointmentRuleText(twoForOne({ appointment_weekdays: null })), null);
  assert.equal(appointmentRuleText(twoForOne({ appointment_weekdays: [1, 2, 3, 4, 5, 6, 7] })), null, 'every day says nothing');
});
