import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeAvailability } from '../../src/scheduling/availability.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import {
  DEFAULT_SCHEDULING_CONFIG,
  type AvailabilityRequest,
  type SchedulingConfig,
  type ServiceTiming,
  type StaffAvailabilityInput,
  type WeeklyHours,
} from '../../src/scheduling/types.js';

const TZ = 'America/Bogota';

// A fixed Wednesday: 2026-08-05. Bogota is UTC-5 (no DST), so 09:00 local = 14:00Z.
const localWed = (h: number, m = 0): Date => zonedPartsToUtc(2026, 8, 5, h, m, TZ);

const T60: ServiceTiming = { duration_min: 60, buffer_before_min: 0, buffer_after_min: 0 };

function staff(id: string, over: Partial<StaffAvailabilityInput> = {}): StaffAvailabilityInput {
  return { id, working_hours: {}, timing: T60, busy: [], exceptions: [], ...over };
}

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
    staff: [staff('st1')],
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
  assert.equal(slots[slots.length - 1].service_end_at.getTime(), localWed(12).getTime());
});

test('staff working hours narrow the site hours (staff 10-12 only)', () => {
  const req = baseReq({ staff: [staff('st1', { working_hours: { wed: [{ start: '10:00', end: '12:00' }] } })] });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  assert.deepEqual(starts, [localWed(10).getTime(), localWed(10, 30).getTime(), localWed(11).getTime()]);
});

test('full site exception blocks the whole day', () => {
  const req = baseReq({ siteExceptions: [{ from: localWed(0), until: localWed(23, 59) }] });
  assert.equal(computeAvailability(req).length, 0);
});

test('partial staff exception 10-11 removes overlapping slots', () => {
  const req = baseReq({ staff: [staff('st1', { exceptions: [{ from: localWed(10), until: localWed(11) }] })] });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  assert.deepEqual(starts, [localWed(9).getTime(), localWed(11).getTime()]);
});

test('buffers extend the blocked window (15m before/after) and shrink availability', () => {
  const req = baseReq({
    staff: [staff('st1', { timing: { duration_min: 60, buffer_before_min: 15, buffer_after_min: 15 } })],
  });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
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
  assert.equal(computeAvailability(req).length, 0);
});

test('service that would cross closing is never offered', () => {
  const req = baseReq({ staff: [staff('st1', { timing: { duration_min: 240, buffer_before_min: 0, buffer_after_min: 0 } })] });
  assert.equal(computeAvailability(req).length, 0);
});

test('specific staff request: only that staff considered', () => {
  const req = baseReq({ staff: [staff('st2')] });
  const slots = computeAvailability(req);
  assert.ok(slots.every((s) => s.staff_id === 'st2'));
});

test('"any staff": slot offered by both, tie-break by lower load then id', () => {
  const req = baseReq({
    staff: [
      staff('st_a'),
      staff('st_b', { busy: [{ from: localWed(8), until: localWed(8, 30) }] }),
    ],
  });
  const nine = computeAvailability(req).find((s) => s.start_at.getTime() === localWed(9).getTime());
  assert.ok(nine);
  assert.equal(nine.staff_id, 'st_a');
  assert.deepEqual(nine.available_staff_ids, ['st_a', 'st_b']);
});

test('active appointment (busy) removes overlapping slots for that staff', () => {
  const req = baseReq({ staff: [staff('st1', { busy: [{ from: localWed(10), until: localWed(11) }] })] });
  const starts = computeAvailability(req).map((s) => s.start_at.getTime());
  assert.deepEqual(starts, [localWed(9).getTime(), localWed(11).getTime()]);
});

test('per-staff durations differ: near close only the shorter-service barber is available', () => {
  const req = baseReq({
    staff: [
      staff('fast', { timing: { duration_min: 30, buffer_before_min: 0, buffer_after_min: 0 } }),
      staff('slow', { timing: { duration_min: 90, buffer_before_min: 0, buffer_after_min: 0 } }),
    ],
  });
  const slots = computeAvailability(req);

  // At 11:30 (site closes 12:00): 30-min "fast" fits (→12:00), 90-min "slow" does not.
  const at1130 = slots.find((s) => s.start_at.getTime() === localWed(11, 30).getTime());
  assert.ok(at1130, '11:30 slot exists for the fast barber');
  assert.deepEqual(at1130.available_staff_ids, ['fast']);
  assert.equal(at1130.service_end_at.getTime(), localWed(12).getTime());

  // At 09:00 both are available, each with its OWN service end.
  const at9 = slots.find((s) => s.start_at.getTime() === localWed(9).getTime());
  assert.ok(at9);
  assert.deepEqual(at9.available_staff_ids, ['fast', 'slow']);
  const fastEnd = at9.candidates.find((c) => c.staff_id === 'fast')!.service_end_at.getTime();
  const slowEnd = at9.candidates.find((c) => c.staff_id === 'slow')!.service_end_at.getTime();
  assert.equal(fastEnd, localWed(9, 30).getTime());
  assert.equal(slowEnd, localWed(10, 30).getTime());
});
