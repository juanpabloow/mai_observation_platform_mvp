import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/** JP-8 §1 — a contract that EVERY write which can change a (staff, day) is wired to the fail-safe
 *  occupancy hook, and the workers are started + stopped with the rest of the worker process. This
 *  guards against a hook being dropped in a later refactor (the convergence itself is covered by the
 *  integration test). */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const BOOKING = read('src/scheduling/booking.ts');
const PAYMENTS = read('src/scheduling/payments.ts');
const TIMEOFF = read('web/lib/timeOffActions.ts');
const SERIES = read('web/lib/scheduleSeriesActions.ts');
const ADMIN = read('web/lib/schedulingAdminActions.ts');
const INDEX = read('src/index.ts');

test('appointment writes mark occupancy dirty (create, status change, service change, moves)', () => {
  assert.ok(BOOKING.includes("from '../occupancy/hooks.js'"), 'booking imports the occupancy hooks');
  // create + status change + service change = a single (staff, day) mark; reschedule + time-correction = a move.
  assert.ok(BOOKING.match(/occupancyOnAppointmentWritten\(/g)!.length >= 3, 'create, transition, and service-change each mark');
  assert.ok(BOOKING.match(/occupancyOnAppointmentMoved\(/g)!.length >= 2, 'reschedule and time/artist correction each mark BOTH days');
});

test('payment writes mark occupancy dirty (record on completion, record on completed, void)', () => {
  assert.ok(PAYMENTS.includes('occupancyOnPayment'), 'payments import + call the occupancy hook');
  assert.ok(PAYMENTS.match(/occupancyOnPayment\(/g)!.length >= 3, 'the two record paths + the void path all mark');
});

test('schedule-config writes mark occupancy dirty (time off/closures, hours, breaks, site/staff state)', () => {
  // Time off / closures: create, edit (old + new range), delete.
  assert.ok(TIMEOFF.match(/occupancyOnException\(/g)!.length >= 4, 'create + edit(×2 ranges) + delete mark the exception days');
  // Weekly hours + usual breaks + recurring blocks: the three series commit points.
  assert.ok(SERIES.match(/occupancyOnSiteScheduleChanged\(/g)!.length >= 3, 'the schedule-save commit points mark the site window');
  // Opening hours / site activation and staff activation / edits.
  assert.ok(ADMIN.includes('occupancyOnSiteScheduleChanged') && ADMIN.includes('occupancyOnStaffHoursChanged'), 'site + staff admin changes mark windows');
});

test('the occupancy workers are started and stopped with the worker process', () => {
  assert.ok(INDEX.includes('startOccupancyRollup()') && INDEX.includes('startOccupancyNightly()'), 'both jobs start');
  assert.ok(INDEX.includes('stopOccupancyRollup()') && INDEX.includes('stopOccupancyNightly()'), 'both jobs stop on shutdown');
});
