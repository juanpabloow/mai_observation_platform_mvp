import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { localDayRangeToUtc, zonedPartsToUtc } from '../../src/scheduling/timezone.js';

/**
 * PURE timezone-range math for scheduling analytics. Proves the local-date range in
 * a site's timezone maps to a HALF-OPEN UTC window [from, to): `from` is local
 * midnight of the first day, `to` is local midnight of the day AFTER the last day —
 * so `appointments.start_at < to` excludes the upper boundary exactly (spec F #4).
 * Bogota is UTC-5 with no DST; a DST zone is included to exercise the two-pass math.
 */

test('single local day → [localMidnight, nextLocalMidnight) in the site tz (Bogota, UTC-5)', () => {
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', 'America/Bogota');
  assert.equal(from.toISOString(), '2026-08-03T05:00:00.000Z', 'local 00:00 Bogota = 05:00 UTC');
  assert.equal(to.toISOString(), '2026-08-04T05:00:00.000Z', 'exclusive upper = next local midnight');
});

test('inclusive multi-day range: `to` is midnight of the day AFTER toYmd', () => {
  const { from, to } = localDayRangeToUtc('2026-08-01', '2026-08-07', 'America/Bogota');
  assert.equal(from.toISOString(), '2026-08-01T05:00:00.000Z');
  assert.equal(to.toISOString(), '2026-08-08T05:00:00.000Z', 'whole Aug 7 included; Aug 8 00:00 excluded');
});

test('an instant exactly at `to` is OUTSIDE the range (half-open, spec F #4)', () => {
  const { from, to } = localDayRangeToUtc('2026-08-03', '2026-08-03', 'America/Bogota');
  const atTo = zonedPartsToUtc(2026, 8, 4, 0, 0, 'America/Bogota'); // next local midnight
  assert.equal(atTo.getTime(), to.getTime());
  // Emulate the SQL predicate start_at >= from AND start_at < to.
  const inRange = (d: Date) => d.getTime() >= from.getTime() && d.getTime() < to.getTime();
  assert.equal(inRange(atTo), false, 'the boundary instant is excluded');
  assert.equal(inRange(new Date(to.getTime() - 1)), true, '1ms before `to` is included');
  assert.equal(inRange(from), true, '`from` itself is included');
});

test('calendar rollover: month boundary', () => {
  const { from, to } = localDayRangeToUtc('2026-01-31', '2026-01-31', 'America/Bogota');
  assert.equal(from.toISOString(), '2026-01-31T05:00:00.000Z');
  assert.equal(to.toISOString(), '2026-02-01T05:00:00.000Z', 'day after Jan 31 is Feb 1');
});

test('DST-observing zone (America/New_York) still yields correct local midnights', () => {
  // 2026-03-07 (EST, UTC-5) → 2026-03-08 crosses spring-forward (02:00 → 03:00).
  const { from, to } = localDayRangeToUtc('2026-03-07', '2026-03-08', 'America/New_York');
  assert.equal(from.toISOString(), '2026-03-07T05:00:00.000Z', 'EST local midnight = 05:00 UTC');
  // Day after Mar 8 local midnight, now EDT (UTC-4) → 04:00 UTC.
  assert.equal(to.toISOString(), '2026-03-09T04:00:00.000Z', 'post-DST local midnight = 04:00 UTC');
});
