import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  assembleRows,
  occupancyPct,
  periodRange,
  shiftPeriod,
  siteTotalRow,
  trendBucketStarts,
  type RawTotals,
} from '../../web/lib/occupancyView.js';

/** JP-8 §3/§4 — the pure view-model: period math, %, and the MONEY GATE (money fields are present
 *  only when canMoney). */

test('periodRange: day / Monday-week / calendar-month', () => {
  assert.deepEqual(periodRange('day', '2026-06-10'), { granularity: 'day', anchor: '2026-06-10', from: '2026-06-10', to: '2026-06-10' });
  // 2026-06-10 is a Wednesday → week Mon 2026-06-08 .. Sun 2026-06-14.
  assert.deepEqual(periodRange('week', '2026-06-10'), { granularity: 'week', anchor: '2026-06-10', from: '2026-06-08', to: '2026-06-14' });
  assert.deepEqual(periodRange('month', '2026-06-10'), { granularity: 'month', anchor: '2026-06-10', from: '2026-06-01', to: '2026-06-30' });
});

test('shiftPeriod + trendBucketStarts', () => {
  assert.equal(shiftPeriod('day', '2026-06-10', 1), '2026-06-11');
  assert.equal(shiftPeriod('week', '2026-06-10', -1), '2026-06-03');
  assert.equal(shiftPeriod('month', '2026-03-31', 1), '2026-04-30'); // clamps to the shorter month
  // The last 3 weekly bucket-starts ending at the week of 2026-06-10 (Mondays).
  assert.deepEqual(trendBucketStarts('week', '2026-06-10', 3), ['2026-05-25', '2026-06-01', '2026-06-08']);
});

test('occupancyPct: ratio, rounding, and null when there is no capacity', () => {
  assert.equal(occupancyPct(60, 480), 13);
  assert.equal(occupancyPct(480, 480), 100);
  assert.equal(occupancyPct(0, 0), null, 'no working hours → no percentage');
  assert.equal(occupancyPct(30, 0), null);
});

const totals = (over: Partial<RawTotals> = {}): RawTotals => ({
  staff_id: 'a', available_min: 480, booked_min: 240, attended_min: 180, no_show_min: 60, outside_hours_min: 0, collected_amount: '120000', ...over,
});

test('assembleRows + siteTotalRow OMIT money unless canMoney (Setter/Staff payload carries none)', () => {
  const staff = [{ id: 'a', name: 'Ana' }, { id: 'b', name: 'Beto' }];
  const map = new Map<string, RawTotals>([['a', totals()], ['b', totals({ staff_id: 'b', available_min: 240, booked_min: 120, collected_amount: '60000' })]]);
  const free = new Map([['a', 300], ['b', 100]]);

  const withMoney = assembleRows(staff, map, free, new Map(), [], true);
  assert.equal(withMoney[0].reservadaPct, 50);
  assert.equal(withMoney[0].atendidaPct, Math.round((180 / 480) * 100));
  assert.equal(withMoney[0].collectedAmount, '120000');
  assert.equal(withMoney[0].salesPerAvailableHour, Math.round(120000 / (480 / 60)), 'collected ÷ available hours');

  const noMoney = assembleRows(staff, map, free, new Map(), [], false);
  assert.equal(noMoney[0].collectedAmount, undefined, 'no collected amount without analytics.view');
  assert.equal(noMoney[0].salesPerAvailableHour, undefined, 'no sales/hour without analytics.view');
  assert.equal(noMoney[0].reservadaPct, 50, 'the non-money metrics are still there');

  const totalNoMoney = siteTotalRow(noMoney, false);
  assert.equal(totalNoMoney.collectedAmount, undefined);
  assert.equal(totalNoMoney.availableMin, 720, 'site total sums capacity');
  const totalMoney = siteTotalRow(withMoney, true);
  assert.equal(Number(totalMoney.collectedAmount), 180000, 'site total sums collected');
});

test('assembleRows: a professional with no rollup data gets a zeroed row', () => {
  const rows = assembleRows([{ id: 'x', name: 'Nuevo' }], new Map(), new Map(), new Map(), [], true);
  assert.equal(rows[0].availableMin, 0);
  assert.equal(rows[0].reservadaPct, null, 'no capacity → no %');
  assert.equal(rows[0].collectedAmount, '0');
});
