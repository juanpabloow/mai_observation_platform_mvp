import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildExecDashboard, buildUsageBreakdown, compareExecutions, OTHER_KEY, planCycle, planUsageOf } from '../../src/analytics/executionsModel.js';

const row = (day: string, production: number, with_ai: number, errors = 0, unread = 0, manual = 0, duration_ms_sum = 0, duration_n = 0) => ({ day, production, manual, with_ai, errors, unread, duration_ms_sum, duration_n });

test('days are filled, «sin IA» is what is left, unread stays out of the shares', () => {
  const d = buildExecDashboard({
    days: ['2026-11-01', '2026-11-02', '2026-11-03'],
    rows: [row('2026-11-01', 100, 30, 5, 0, 7), row('2026-11-03', 50, 10, 0, 10)],
    endings: [],
  });
  assert.equal(d.days.length, 3);
  assert.deepEqual(d.days[1], { day: '2026-11-02', production: 0, manual: 0, withAi: 0, noAi: 0, errors: 0, unread: 0, durationMsSum: 0, durationN: 0 });
  assert.equal(d.avgDurationMs, null, 'no duration reported → unknown, not 0');
  assert.equal(d.days[0].noAi, 65);
  assert.deepEqual(d.totals, { production: 150, manual: 7, withAi: 40, noAi: 95, errors: 5, unread: 10 });
});

test('comparison: shares as they are, volumes per day when lengths differ, unfair baseline flagged', () => {
  const days = (n: number, production: number, withAi: number, unread = 0) =>
    buildExecDashboard({
      days: Array.from({ length: n }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`),
      rows: [row('2026-10-01', production, withAi, 0, unread)],
      endings: [],
    });
  const cur = days(7, 700, 350);
  const prev = days(14, 2800, 700);
  const c = compareExecutions(cur, prev, { current: 7, previous: 14 });
  assert.equal(c.perDay, true);
  assert.deepEqual(c.changes.production, { kind: 'pct', pct: -50 }); // 100/day vs 200/day
  assert.equal(c.current.wastePct, 50);
  assert.equal(c.previous.wastePct, 75);
  assert.deepEqual(c.changes.wastePct, { kind: 'pct', pct: -33.3 });
  assert.equal(c.current.perAnswer, 2);

  const unfair = compareExecutions(cur, days(7, 1000, 100, 400), { current: 7, previous: 7 });
  assert.equal(unfair.changes.wastePct.kind, 'unavailable');
  assert.equal(unfair.changes.production.kind, 'pct', 'volumes are still comparable');
});

test('plan cycle: reset day this month or last, calendar month by default', () => {
  const at = (iso: string) => new Date(iso);
  assert.deepEqual(planCycle(at('2026-11-20T10:00:00Z'), 15), { start: at('2026-11-15T00:00:00Z'), end: at('2026-12-15T00:00:00Z') });
  assert.deepEqual(planCycle(at('2026-11-03T10:00:00Z'), 15), { start: at('2026-10-15T00:00:00Z'), end: at('2026-11-15T00:00:00Z') });
  assert.deepEqual(planCycle(at('2026-01-03T10:00:00Z'), 10), { start: at('2025-12-10T00:00:00Z'), end: at('2026-01-10T00:00:00Z') });
  assert.deepEqual(planCycle(at('2026-11-03T10:00:00Z'), null), { start: at('2026-11-01T00:00:00Z'), end: at('2026-12-01T00:00:00Z') });
});

test('plan usage: share, projection at the current pace, none in the first hours', () => {
  const u = planUsageOf({ connectionId: 'c', connectionName: 'n8n', limit: 8000, resetDay: 1, used: 2000, now: new Date('2026-11-11T00:00:00Z') });
  assert.equal(u.usedPct, 25);
  assert.equal(u.projected, 6000); // 10 of 30 days → ×3
  assert.equal(u.projectedPct, 75);
  assert.equal(u.daysLeft, 20);
  const early = planUsageOf({ connectionId: 'c', connectionName: 'n8n', limit: null, resetDay: 1, used: 40, now: new Date('2026-11-01T03:00:00Z') });
  assert.equal(early.projected, null);
  assert.equal(early.usedPct, null, 'no limit → no share');
});

const u = (day: string, key: string, production: number, with_ai = 0) => ({ day, key, name: key ? key.toUpperCase() : null, chart_color: null, production, with_ai, errors: 0, unread: 0 });

test('who uses it most: ranked, daily aligned, share, change, past 8 folded into «Otros»', () => {
  const days = ['2026-11-01', '2026-11-02'];
  const b = buildUsageBreakdown({
    days,
    rows: [u('2026-11-01', 'gallery', 30, 10), u('2026-11-02', 'gallery', 50, 10), u('2026-11-02', 'spa', 20), u('2026-11-01', '', 0)],
    previousRows: [u('2026-10-30', 'gallery', 160)],
    periodDays: { current: 2, previous: 2 },
  });
  assert.equal(b.total, 100);
  assert.deepEqual(b.entities.map((e) => [e.key, e.production, e.sharePct, e.daily]), [
    ['gallery', 80, 80, [30, 50]],
    ['spa', 20, 20, [0, 20]],
    ['', 0, 0, [0, 0]],
  ]);
  assert.equal(b.entities[2].name, 'Sin negocio asignado');
  assert.deepEqual(b.entities[0].change, { kind: 'pct', pct: -50 });
  assert.deepEqual(b.entities[1].change, { kind: 'no_prev' });
  assert.equal(b.entities[0].wastePct, 75);

  const many = buildUsageBreakdown({
    days,
    rows: Array.from({ length: 10 }, (_, i) => u('2026-11-01', `wf${i}`, 100 - i)),
    previousRows: [u('2026-10-30', 'wf9', 10), u('2026-10-30', 'wf0', 5)],
    periodDays: { current: 2, previous: 2 },
  });
  assert.equal(many.entities.length, 8);
  const other = many.entities[7];
  assert.equal(other.key, OTHER_KEY);
  assert.equal(other.name, 'Otros (3)');
  assert.equal(other.production, 93 + 92 + 91);
  assert.equal(other.isOther, true);
  // «Otros» compares with what the folded ones did before (wf9's 10), not the kept wf0.
  assert.deepEqual(other.change, { kind: 'pct', pct: 2660 });
  assert.equal(many.total, many.entities.reduce((n, e) => n + e.production, 0));
});

test('average duration is weighted by executions, across days', () => {
  const d = buildExecDashboard({ days: ['2026-11-01', '2026-11-02'], rows: [row('2026-11-01', 3, 1, 0, 0, 0, 3000, 3), row('2026-11-02', 1, 1, 0, 0, 0, 5000, 1)], endings: [] });
  assert.equal(d.avgDurationMs, 2000);
});
