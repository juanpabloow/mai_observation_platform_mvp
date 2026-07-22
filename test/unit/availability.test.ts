import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeAvailability } from '../../src/scheduling/availability.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import {
  DEFAULT_SCHEDULING_CONFIG,
  type AvailabilityRequest,
  type SchedulingConfig,
  type WeeklyHours,
} from '../../src/scheduling/types.js';

const TZ = 'America/Bogota';

// A fixed Wednesday: 2026-08-05. Bogota is UTC-5 (no DST), so 09:00 local = 14:00Z.
const localWed = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 5, h, m, TZ);

function baseReq(overrides: Partial<AvailabilityRequest> = {}): AvailabilityRequest {
  const openingHours: WeeklyHours = { wed: [{ start: '09:00', end: '12:00' }] };
  const cfg: SchedulingConfig = {
    ...DEFAULT_SCHEDULING_CONFIG,
    slot_interval_min: 30,
    min_notice_min: 0,
    booking_horizon_days: 365,
  };
  return {
    site: { id: 'site1', timezone: TZ, opening_hours: openingHours, scheduling_config: cfg },
    service: { duration_min: 60, buffer_before_min: 0, buffer_after_min: 0 },
    staff: [{ id: 'st1', working_hours: {}, busy: [], exceptions: [] }],
    siteExceptions: [],
    from: localWed(0),
    to: localWed(23, 59),
    now: localWed(0),
    ...overrides,
  };
}

test('site+staff hours: 09-12, 60min service, 30min grid → 09:00,09:30,10:00,10:30,11:00', () => {
  const slots = computeAvailability(baseReq());
  const starts = slots.map((s) => s.start_at.getTime());
  assert.deepEqual(starts, [
    localWed(9).getTime(),
    localWed(9, 30).getTime(),
    localWed(10).getTime(),
    localWed(10, 30).getTime(),
    localWed(11).getTime(),
  ]);
  // last service ends at 12:00 exactly (fits), none start at 11:30 (would end 12:30)
  assert.equal(slots[slots.length - 1].service_end_at.getTime(), localWed(12).getTime());
});

test('staff working hours narrow the site hours (staff 10-12 only)', () => {
  const req = baseReq({
    staff: [{ id: 'st1', working_hours: { wed: [{ start: '10:00', end: '12:00' }] }, busy: [], exceptions: [] }],
  });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  assert.deepEqual(starts, [localWed(10).getTime(), localWed(10, 30).getTime(), localWed(11).getTime()]);
});

test('full site exception blocks the whole day', () => {
  const req = baseReq({ siteExceptions: [{ from: localWed(0), until: localWed(23, 59) }] });
  assert.equal(computeAvailability(req).length, 0);
});

test('partial staff exception 10-11 removes overlapping slots', () => {
  const req = baseReq({
    staff: [{ id: 'st1', working_hours: {}, busy: [], exceptions: [{ from: localWed(10), until: localWed(11) }] }],
  });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  // 09:00 (ends 10:00 ok), 09:30 crosses 10:00→blocked, 10:00/10:30 blocked, 11:00 ok
  assert.deepEqual(starts, [localWed(9).getTime(), localWed(11).getTime()]);
});

test('buffers extend the blocked window (15m before/after) and shrink availability', () => {
  const req = baseReq({
    service: { duration_min: 60, buffer_before_min: 15, buffer_after_min: 15 },
  });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  // earliest S has blocked_from = S-15 ≥ 09:00 → S ≥ 09:15; grid(30 from midnight)→09:30
  // latest blocked_until = S+75 ≤ 12:00 → S ≤ 10:45; grid → 10:30
  assert.deepEqual(starts, [localWed(9, 30).getTime(), localWed(10).getTime(), localWed(10, 30).getTime()]);
});

test('min_notice filters out slots too soon', () => {
  const req = baseReq({
    site: {
      id: 'site1',
      timezone: TZ,
      opening_hours: { wed: [{ start: '09:00', end: '12:00' }] },
      scheduling_config: { ...DEFAULT_SCHEDULING_CONFIG, slot_interval_min: 30, min_notice_min: 90, booking_horizon_days: 365 },
    },
    now: localWed(9),
  });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  // now=09:00 + 90m notice → S ≥ 10:30
  assert.deepEqual(starts, [localWed(10, 30).getTime(), localWed(11).getTime()]);
});

test('booking_horizon filters out slots too far out', () => {
  const req = baseReq({
    site: {
      id: 'site1',
      timezone: TZ,
      opening_hours: { wed: [{ start: '09:00', end: '12:00' }] },
      scheduling_config: { ...DEFAULT_SCHEDULING_CONFIG, slot_interval_min: 30, min_notice_min: 0, booking_horizon_days: 0 },
    },
    now: localWed(0),
  });
  // horizon 0 days → maxStart = now (00:00), all 09:00+ slots excluded
  assert.equal(computeAvailability(req).length, 0);
});

test('service that would cross closing is never offered', () => {
  const req = baseReq({ service: { duration_min: 240, buffer_before_min: 0, buffer_after_min: 0 } });
  // 4h service cannot fit in a 3h window
  assert.equal(computeAvailability(req).length, 0);
});

test('specific staff request: only that staff considered', () => {
  const req = baseReq({
    staff: [{ id: 'st2', working_hours: {}, busy: [], exceptions: [] }],
  });
  const slots = computeAvailability(req);
  assert.ok(slots.every((s) => s.staff_id === 'st2'));
});

test('"any staff": slot offered by both, tie-break by lower load then id', () => {
  const req = baseReq({
    staff: [
      // st_b has one appt earlier that day (higher load) → st_a should win the tie
      { id: 'st_a', working_hours: {}, busy: [], exceptions: [] },
      { id: 'st_b', working_hours: {}, busy: [{ from: localWed(8), until: localWed(8, 30) }], exceptions: [] },
    ],
  });
  const slots = computeAvailability(req);
  const nine = slots.find((s) => s.start_at.getTime() === localWed(9).getTime());
  assert.ok(nine);
  assert.equal(nine.staff_id, 'st_a');
  assert.deepEqual(nine.available_staff_ids, ['st_a', 'st_b']);
});

test('active appointment (busy) removes overlapping slots for that staff', () => {
  const req = baseReq({
    staff: [{ id: 'st1', working_hours: {}, busy: [{ from: localWed(10), until: localWed(11) }], exceptions: [] }],
  });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  assert.deepEqual(starts, [localWed(9).getTime(), localWed(11).getTime()]);
});
