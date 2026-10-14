import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { localDatesInRange, localDaysInWindow, zonedPartsToUtc } from '../../src/scheduling/timezone.js';

/**
 * REGRESSION: has_availability used the boundary-INCLUSIVE localDatesInRange, so a window
 * ending exactly at a local midnight answered for one extra day. localDaysInWindow is the
 * end-exclusive reading of [from, to). Bogotá is UTC−5 (local midnight = 05:00Z).
 */

const TZ = 'America/Bogota';
const bog = (d: number, h = 0, m = 0, month = 11) => zonedPartsToUtc(2026, month, d, h, m, TZ);

test('one local day [00:00, next 00:00) → exactly that day (the old reading added the next)', () => {
  assert.deepEqual(localDaysInWindow(bog(4), bog(5), TZ), ['2026-11-04']);
  assert.equal(localDatesInRange(bog(4), bog(5), TZ).length, 2, 'documents the old, inclusive behaviour');
});

test('several days, and a window ending one ms after midnight', () => {
  assert.deepEqual(localDaysInWindow(bog(4), bog(7), TZ), ['2026-11-04', '2026-11-05', '2026-11-06']);
  assert.deepEqual(localDaysInWindow(bog(4), new Date(bog(5).getTime() + 1), TZ), ['2026-11-04', '2026-11-05']);
  assert.deepEqual(localDaysInWindow(bog(4), bog(4, 23, 59), TZ), ['2026-11-04']);
});

test('partial days and month boundaries', () => {
  assert.deepEqual(localDaysInWindow(bog(4, 15), bog(4, 18), TZ), ['2026-11-04']);
  assert.deepEqual(localDaysInWindow(bog(4, 22), bog(5, 2), TZ), ['2026-11-04', '2026-11-05']);
  assert.deepEqual(localDaysInWindow(bog(30), bog(2, 0, 0, 12), TZ), ['2026-11-30', '2026-12-01']);
});

test('dates are LOCAL to the site: UTC midnights are 19:00 the day before in Bogotá', () => {
  const from = new Date('2026-11-04T00:00:00Z'); // 2026-11-03 19:00 Bogotá
  const to = new Date('2026-11-05T00:00:00Z'); // 2026-11-04 19:00 Bogotá
  assert.deepEqual(localDaysInWindow(from, to, TZ), ['2026-11-03', '2026-11-04']);
  // The same instants in UTC are one day.
  assert.deepEqual(localDaysInWindow(from, to, 'UTC'), ['2026-11-04']);
});

test('empty or inverted windows → no days', () => {
  assert.deepEqual(localDaysInWindow(bog(4), bog(4), TZ), []);
  assert.deepEqual(localDaysInWindow(bog(5), bog(4), TZ), []);
});
