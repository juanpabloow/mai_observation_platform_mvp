import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeReason, normalizeTimeOff } from '../../web/lib/timeOffValidation.js';

test('normalizeTimeOff full_day: a single day covers [day 00:00, nextDay 00:00)', () => {
  assert.deepEqual(normalizeTimeOff({ mode: 'full_day', startDate: '2026-10-22', endDate: '2026-10-22' }), {
    ok: true,
    startLocal: '2026-10-22T00:00',
    endLocal: '2026-10-23T00:00',
  });
});

test('normalizeTimeOff full_day: a range spans to the midnight after the last day', () => {
  assert.deepEqual(normalizeTimeOff({ mode: 'full_day', startDate: '2026-12-24', endDate: '2026-12-26' }), {
    ok: true,
    startLocal: '2026-12-24T00:00',
    endLocal: '2026-12-27T00:00',
  });
});

test('normalizeTimeOff full_day: month/year rollover on the exclusive end', () => {
  assert.deepEqual(normalizeTimeOff({ mode: 'full_day', startDate: '2026-12-31', endDate: '2026-12-31' }).ok, true);
  const r = normalizeTimeOff({ mode: 'full_day', startDate: '2026-12-31', endDate: '2026-12-31' });
  assert.equal(r.ok && r.endLocal, '2027-01-01T00:00');
});

test('normalizeTimeOff full_day: end before start is refused', () => {
  const r = normalizeTimeOff({ mode: 'full_day', startDate: '2026-10-22', endDate: '2026-10-21' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /endDate/);
});

test('normalizeTimeOff partial: one date + from–to within the day', () => {
  assert.deepEqual(normalizeTimeOff({ mode: 'partial', date: '2026-10-22', startTime: '14:00', endTime: '16:00' }), {
    ok: true,
    startLocal: '2026-10-22T14:00',
    endLocal: '2026-10-22T16:00',
  });
});

test('normalizeTimeOff partial: end must be after start', () => {
  const r = normalizeTimeOff({ mode: 'partial', date: '2026-10-22', startTime: '16:00', endTime: '14:00' });
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /endTime/);
  const eq = normalizeTimeOff({ mode: 'partial', date: '2026-10-22', startTime: '16:00', endTime: '16:00' });
  assert.equal(eq.ok, false, 'equal times are not a block');
});

test('normalizeTimeOff rejects malformed dates/times', () => {
  assert.equal(normalizeTimeOff({ mode: 'full_day', startDate: '2026-13-01', endDate: '2026-13-01' }).ok, false);
  assert.equal(normalizeTimeOff({ mode: 'full_day', startDate: '2026-02-30', endDate: '2026-02-30' }).ok, false);
  assert.equal(normalizeTimeOff({ mode: 'partial', date: '2026-10-22', startTime: '25:00', endTime: '26:00' }).ok, false);
  assert.equal(normalizeTimeOff({ mode: 'partial', date: 'nope', startTime: '09:00', endTime: '10:00' }).ok, false);
});

test('normalizeReason: trims, blank→null, caps length', () => {
  assert.equal(normalizeReason('  Vacaciones  '), 'Vacaciones');
  assert.equal(normalizeReason('   '), null);
  assert.equal(normalizeReason(undefined), null);
  assert.equal(normalizeReason('x'.repeat(300))?.length, 200);
});
