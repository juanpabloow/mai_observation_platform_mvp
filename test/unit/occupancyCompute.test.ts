import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { occupancyMinutesForDay, enumerateLocalDays, localDayKey, type OccupancyApptInput } from '../../src/occupancy/compute.js';
import type { Span } from '../../src/scheduling/intervals.js';

/** JP-8 §1 — the pure occupancy MATH: capacity = Σ shift; occupied = SERVICE minutes clipped to the
 *  shift; status mapping; the "fuera de horario" split. No DB, no clock. */

const H = (h: number, m = 0): number => Date.UTC(2026, 0, 5, h, m); // a fixed Monday, UTC ms
const appt = (startH: number, startM: number, endH: number, endM: number, status: OccupancyApptInput['status']): OccupancyApptInput => ({
  startMs: H(startH, startM),
  endMs: H(endH, endM),
  status,
});

test('occupancyMinutesForDay: capacity, status mapping, buffers-excluded, and the outside-hours clip', () => {
  // Shift 09:00–12:00 and 13:00–18:00 (lunch 12–13 is NOT capacity) → 8h = 480 min.
  const shift: Span[] = [
    { start: H(9), end: H(12) },
    { start: H(13), end: H(18) },
  ];
  const appts: OccupancyApptInput[] = [
    appt(10, 0, 11, 0, 'completed'), // 60 min, fully inside → booked 60, attended 60
    appt(14, 0, 14, 30, 'no_show'), // 30 min inside → booked 30, no_show 30
    appt(17, 30, 18, 30, 'scheduled'), // straddles 18:00 close → 30 in, 30 out
    appt(12, 30, 13, 0, 'confirmed'), // entirely inside lunch (not capacity) → 0 in, 30 out
    appt(15, 0, 16, 0, 'cancelled'), // never counts
  ];
  const m = occupancyMinutesForDay(shift, appts);
  assert.equal(m.availableMin, 480, 'capacity = shift minus lunch');
  assert.equal(m.bookedMin, 120, 'reservada = inside minutes of scheduled/confirmed/completed/no_show (60+30+30+0)');
  assert.equal(m.attendedMin, 60, 'atendida = completed inside minutes');
  assert.equal(m.noShowMin, 30, 'no-show inside minutes (the reservada−atendida gap source)');
  assert.equal(m.outsideHoursMin, 60, 'fuera de horario = the clipped-off parts (30 after close + 30 in lunch)');
});

test('occupancyMinutesForDay: a day fully off has zero capacity; an outside appointment never inflates %', () => {
  const m = occupancyMinutesForDay([], [appt(10, 0, 11, 0, 'completed')]);
  assert.equal(m.availableMin, 0);
  assert.equal(m.bookedMin, 0, 'nothing is "inside" an empty shift');
  assert.equal(m.attendedMin, 0);
  assert.equal(m.outsideHoursMin, 60, 'the whole service is fuera de horario');
});

test('occupancyMinutesForDay: buffers are NOT occupied — only the service window counts', () => {
  // A 30-min service fully inside the shift. Buffers live on blocked_* and are never passed here.
  const shift: Span[] = [{ start: H(9), end: H(18) }];
  const m = occupancyMinutesForDay(shift, [appt(10, 0, 10, 30, 'completed')]);
  assert.equal(m.bookedMin, 30, 'service minutes only');
  assert.equal(m.attendedMin, 30);
});

test('enumerateLocalDays + localDayKey: inclusive local-day range (no-DST zone)', () => {
  assert.deepEqual(enumerateLocalDays('2026-01-01', '2026-01-03', 'America/Bogota'), ['2026-01-01', '2026-01-02', '2026-01-03']);
  assert.deepEqual(enumerateLocalDays('2026-01-02', '2026-01-02', 'America/Bogota'), ['2026-01-02']);
  // Bogotá is UTC−5: 2026-01-02 02:00Z is still 2026-01-01 local.
  assert.equal(localDayKey(new Date('2026-01-02T02:00:00Z'), 'America/Bogota'), '2026-01-01');
});
