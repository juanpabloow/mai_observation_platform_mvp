import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { localStartFields, localMomentFields, timeLabel } from '../../web/lib/localTime.ts';
import { computeFreeBlocks, computeHasAvailability, type FreeSlotInput } from '../../web/lib/availabilityView.ts';

/** Pure label + free-block logic (no HTTP/DB). The bug: a 16:00Z appointment for a Bogotá
 *  site was read as "4:00 p. m." instead of 11:00 a. m. */

const BOG = 'America/Bogota';
const MX = 'America/Mexico_City'; // UTC-6 (one hour behind Bogotá)

test('localStartFields labels 16:00Z as 11:00 in Bogotá, and the tz shifts it', () => {
  const instant = zonedPartsToUtc(2026, 8, 5, 11, 0, BOG); // 11:00 local == 16:00Z
  assert.equal(instant.toISOString(), '2026-08-05T16:00:00.000Z');
  const b = localStartFields(instant, BOG, 'es-CO');
  assert.equal(b.start_local, '2026-08-05T11:00:00-05:00', 'offset-ISO is 11:00-05:00, not 16:00Z');
  assert.equal(b.day, '2026-08-05');
  assert.ok(b.start_label.startsWith('11:00'), `label leads with 11:00 (was ${b.start_label})`);
  assert.ok(!b.start_label.startsWith('4:00'), 'never the raw-UTC 4:00 misread');
  // tz override shifts the labels (Mexico City is one hour behind).
  const m = localStartFields(instant, MX, 'es-CO');
  assert.equal(m.start_local, '2026-08-05T10:00:00-06:00');
  assert.ok(m.start_label.startsWith('10:00') && m.start_label !== b.start_label, 'tz shifts the label');
});

test('localMomentFields gives an offset-ISO + a spoken "date, time"', () => {
  const instant = zonedPartsToUtc(2026, 8, 5, 15, 30, BOG); // 20:30Z
  const m = localMomentFields(instant, BOG, 'es-CO');
  assert.equal(m.local, '2026-08-05T15:30:00-05:00');
  assert.ok(m.label.includes('agosto') && m.label.includes('3:30'), `spoken date+time (was ${m.label})`);
});

// Build free slots: `service` minutes long, starting at each of `hours` (local wall clock).
function slots(day: [number, number, number], starts: string[], serviceMin: number): FreeSlotInput[] {
  return starts.map((hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const start = zonedPartsToUtc(day[0], day[1], day[2], h, m, BOG);
    return { start_at: start, service_end_at: new Date(start.getTime() + serviceMin * 60_000), staff_id: 'ana', staff_name: 'Coneja' };
  });
}
const STEP = 15 * 60_000; // slot_interval 15 min
const D: [number, number, number] = [2026, 8, 5];

test('free_blocks: an appointment in the middle → exactly two blocks (9→11, 12→18)', () => {
  // 60-min service, 15-min grid, an 11:00–12:00 appointment: free starts 9:00–10:00 then 12:00–17:00.
  const free = slots(D, ['09:00', '09:15', '09:30', '09:45', '10:00', '12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30', '13:45', '14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30', '15:45', '16:00', '16:15', '16:30', '16:45', '17:00'], 60);
  const blocks = computeFreeBlocks(free, BOG, 'es-CO', STEP);
  assert.equal(blocks.length, 2, 'exactly two free blocks');
  assert.equal(blocks[0].first_time, '09:00');
  assert.equal(blocks[0].from_label, timeLabel(zonedPartsToUtc(2026, 8, 5, 9, 0, BOG), BOG, 'es-CO'));
  assert.equal(blocks[0].to_label, timeLabel(zonedPartsToUtc(2026, 8, 5, 11, 0, BOG), BOG, 'es-CO'), 'run of 60-min slots 9:00–10:00 ends at 11:00');
  assert.equal(blocks[0].day, '2026-08-05');
  assert.equal(blocks[0].staff_name, 'Coneja');
  assert.equal(blocks[1].first_time, '12:00');
  assert.equal(blocks[1].from_label, timeLabel(zonedPartsToUtc(2026, 8, 5, 12, 0, BOG), BOG, 'es-CO'));
  assert.equal(blocks[1].to_label, timeLabel(zonedPartsToUtc(2026, 8, 5, 18, 0, BOG), BOG, 'es-CO'), '…ends at 18:00');
});

test('free_blocks: a fully free day → one block; a fully booked day → none', () => {
  const fullDay = slots(D, ['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30', '10:45', '11:00', '11:15', '11:30', '11:45', '12:00', '12:15', '12:30', '12:45', '13:00', '13:15', '13:30', '13:45', '14:00', '14:15', '14:30', '14:45', '15:00', '15:15', '15:30', '15:45', '16:00', '16:15', '16:30', '16:45', '17:00'], 60);
  const one = computeFreeBlocks(fullDay, BOG, 'es-CO', STEP);
  assert.equal(one.length, 1, 'contiguous → single block');
  assert.equal(one[0].first_time, '09:00');
  assert.equal(one[0].to_label, timeLabel(zonedPartsToUtc(2026, 8, 5, 18, 0, BOG), BOG, 'es-CO'));
  assert.deepEqual(computeFreeBlocks([], BOG, 'es-CO', STEP), [], 'no free slots → no blocks');
});

test('has_availability is per requested day (false for a day with zero slots)', () => {
  const free = slots(D, ['09:00'], 60);
  const map = computeHasAvailability(['2026-08-05', '2026-08-06'], free.map((s) => '2026-08-05'));
  assert.deepEqual(map, { '2026-08-05': true, '2026-08-06': false });
});
