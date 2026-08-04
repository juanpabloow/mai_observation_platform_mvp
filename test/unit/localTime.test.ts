import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  isValidTimeZone,
  isSupportedLocale,
  localIsoWithOffset,
  localDay,
  timeLabel,
  dateLabel,
  localTimeFields,
} from '../../web/lib/localTime.js';

/**
 * C-6 local-time formatter. The high-risk cases the phase calls out: the local date can
 * differ from the UTC date (midnight boundary), and a DST-observing zone must show the
 * correct offset on either side of a transition. UTC (Bogotá is UTC-5, no DST) proves
 * nothing about DST — so New York is used for that.
 */

test('midnight boundary: a UTC-next-day instant reports the LOCAL date', () => {
  // 2026-08-05T02:00:00Z is still 2026-08-04, 21:00 in Bogotá (UTC-5).
  const inst = new Date('2026-08-05T02:00:00Z');
  assert.equal(localDay(inst, 'America/Bogota'), '2026-08-04', 'day is the LOCAL calendar date');
  assert.equal(localIsoWithOffset(inst, 'America/Bogota'), '2026-08-04T21:00:00-05:00');
  const dl = dateLabel(inst, 'America/Bogota', 'es-CO');
  assert.ok(dl.includes('agosto') && dl.includes('4'), `date_label is the local date: ${dl}`);
});

test('Bogotá afternoon: 22:00Z → 5:00 p.m., correct offset + day', () => {
  const inst = new Date('2026-08-04T22:00:00Z');
  assert.equal(localIsoWithOffset(inst, 'America/Bogota'), '2026-08-04T17:00:00-05:00');
  assert.equal(localDay(inst, 'America/Bogota'), '2026-08-04');
  const lbl = timeLabel(inst, 'America/Bogota', 'es-CO');
  assert.ok(lbl.includes('5:00'), `12-hour label: ${lbl}`);
  assert.ok(/p\.?\s?m\.?/i.test(lbl), `has p.m.: ${lbl}`);
  assert.ok(!lbl.includes('17'), '12-hour, not 24-hour');
});

test('DST: New York shows -05:00 before and -04:00 after the spring-forward', () => {
  // US spring-forward 2026 = Sun Mar 8. Sat Mar 7 is EST (-5); Mon Mar 9 is EDT (-4).
  const before = localIsoWithOffset(new Date('2026-03-07T17:00:00Z'), 'America/New_York');
  const after = localIsoWithOffset(new Date('2026-03-09T17:00:00Z'), 'America/New_York');
  assert.ok(before.endsWith('-05:00'), `pre-DST offset: ${before}`);
  assert.ok(after.endsWith('-04:00'), `post-DST offset: ${after}`);
  assert.equal(before.slice(11, 16), '12:00', 'EST: 17:00Z → 12:00');
  assert.equal(after.slice(11, 16), '13:00', 'EDT: 17:00Z → 13:00');
});

test('UTC instant formats with +00:00', () => {
  assert.equal(localIsoWithOffset(new Date('2026-08-04T22:00:00Z'), 'UTC'), '2026-08-04T22:00:00+00:00');
});

test('localTimeFields returns all six additive fields', () => {
  const start = new Date('2026-08-04T22:00:00Z');
  const end = new Date('2026-08-04T22:45:00Z');
  const f = localTimeFields(start, end, 'America/Bogota', 'es-CO');
  assert.deepEqual(Object.keys(f).sort(), ['date_label', 'day', 'end_label', 'end_local', 'start_label', 'start_local']);
  assert.equal(f.start_local, '2026-08-04T17:00:00-05:00');
  assert.equal(f.end_local, '2026-08-04T17:45:00-05:00');
  assert.equal(f.day, '2026-08-04');
});

test('validation: IANA timezone + locale support', () => {
  assert.ok(isValidTimeZone('America/Bogota'));
  assert.ok(isValidTimeZone('UTC'));
  assert.ok(!isValidTimeZone('America/Nowhere'));
  assert.ok(!isValidTimeZone('not a zone'));
  assert.ok(!isValidTimeZone(''));
  assert.ok(isSupportedLocale('es-CO'));
  assert.ok(isSupportedLocale('en-US'));
  assert.ok(!isSupportedLocale('zz-ZZ'));
  assert.ok(!isSupportedLocale(''));
});
