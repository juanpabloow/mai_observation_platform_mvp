import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  addDays,
  applyOpsInMemory,
  effectiveOccurrence,
  endDateAfterCount,
  expandSeries,
  firstOpenDate,
  localMinuteToUtc,
  planDelete,
  planEdit,
  planRoutine,
  splitDayRanges,
  weekdayOf,
  type ScheduleSeries,
  type SeriesOverride,
} from '../../src/scheduling/series.js';
import { computeAvailability } from '../../src/scheduling/availability.js';
import { reviewReasons } from '../../src/scheduling/effectiveSchedule.js';
import { DEFAULT_SCHEDULING_CONFIG } from '../../src/scheduling/types.js';

/**
 * Recurring schedule engine (migration 1818). Business clock: Bogotá (UTC−5, no DST).
 * "Now" = Wed 21 Oct 2026, 16:40 local = 21:40Z — the prototype's reference moment.
 */
const TZ = 'America/Bogota';
const NOW = new Date('2026-10-21T21:40:00Z');
const H = (h: number, m = 0) => h * 60 + m;

/** María's usual lunch: Thursdays 13:00–14:00, since always (a converted weekly-hours gap). */
const lunchThu: ScheduleSeries = {
  id: 'lunch-thu',
  site_id: 'site',
  staff_id: 'maria',
  kind: 'break',
  weekdays: [4],
  start_min: H(13),
  end_min: H(14),
  starts_on: null,
  ends_on: null,
  reason: null,
  public_reason: null,
};

/** "Formación interna", Tomás · Tue and Fri 17:30–18:30, from Tue 6 Oct. */
const training: ScheduleSeries = {
  id: 'training',
  site_id: 'site',
  staff_id: 'tomas',
  kind: 'block',
  weekdays: [2, 5],
  start_min: H(17, 30),
  end_min: H(18, 30),
  starts_on: '2026-10-06',
  ends_on: null,
  reason: 'Formación interna',
  public_reason: null,
};

test('weekday arithmetic is calendar math (0 = Sunday)', () => {
  assert.equal(weekdayOf('2026-10-21'), 3); // Wednesday
  assert.equal(weekdayOf('2026-10-22'), 4);
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('occurrences are anchored to the BUSINESS timezone', () => {
  const [o] = expandSeries([lunchThu], [], '2026-10-22', '2026-10-22', TZ);
  assert.equal(o.from.toISOString(), '2026-10-22T18:00:00.000Z'); // 13:00 Bogotá
  assert.equal(o.until.toISOString(), '2026-10-22T19:00:00.000Z');
  assert.equal(localMinuteToUtc('2026-10-22', 1440, TZ).toISOString(), '2026-10-23T05:00:00.000Z');
});

test('series start, end, repeat days and excluded dates bound the occurrences', () => {
  const ended: ScheduleSeries = { ...training, ends_on: '2026-10-20' };
  const all = expandSeries([ended], [], '2026-10-01', '2026-10-31', TZ).map((o) => o.date);
  assert.deepEqual(all, ['2026-10-06', '2026-10-09', '2026-10-13', '2026-10-16', '2026-10-20']);
  const skip: SeriesOverride[] = [{ series_id: 'training', occurrence_date: '2026-10-13', action: 'skip', start_min: null, end_min: null }];
  const kept = expandSeries([ended], skip, '2026-10-01', '2026-10-31', TZ).map((o) => o.date);
  assert.ok(!kept.includes('2026-10-13'), 'an excluded date never blocks');
  assert.equal(endDateAfterCount([2, 5], '2026-10-27', 3), '2026-11-03');
});

test('PRIORITY CASE: moving ONE Thursday lunch to 14–15 is an override of the same break, not a second block', () => {
  const plan = planEdit({ series: lunchThu, overrides: [], scope: 'date', date: '2026-10-22', patch: { start_min: H(14), end_min: H(15) }, now: NOW, timeZone: TZ });
  assert.ok(plan.ok);
  assert.deepEqual(plan.ops, [{ op: 'upsert_override', series: { id: 'lunch-thu' }, date: '2026-10-22', action: 'move', start_min: H(14), end_min: H(15) }]);
  const after = applyOpsInMemory([lunchThu], [], plan.ops);
  assert.equal(after.series.length, 1, 'still ONE break');
  const occ = expandSeries(after.series, after.overrides, '2026-10-22', '2026-10-29', TZ);
  assert.deepEqual(occ.map((o) => [o.date, o.start_min, o.end_min, o.moved]), [
    ['2026-10-22', H(14), H(15), true],
    ['2026-10-29', H(13), H(14), false],
  ]);
  // Reopening the 22nd shows ITS values (14–15) and that it is an exception.
  const reopened = effectiveOccurrence(after.series[0], after.overrides, '2026-10-22', TZ);
  assert.equal(reopened?.start_min, H(14));
  assert.equal(reopened?.moved, true);
  // "Volver al horario habitual" removes the exception.
  const back = planEdit({ series: lunchThu, overrides: after.overrides, scope: 'date', date: '2026-10-22', patch: { start_min: H(13), end_min: H(14) }, now: NOW, timeZone: TZ });
  assert.ok(back.ok);
  assert.deepEqual(back.ops, [{ op: 'delete_override', series_id: 'lunch-thu', date: '2026-10-22' }]);
});

test('the moved lunch is discounted ONCE from availability (14–15 blocked, 13–14 free)', () => {
  const after = applyOpsInMemory([lunchThu], [], [{ op: 'upsert_override', series: { id: 'lunch-thu' }, date: '2026-10-22', action: 'move', start_min: H(14), end_min: H(15) }]);
  const occ = expandSeries(after.series, after.overrides, '2026-10-22', '2026-10-22', TZ);
  const slots = computeAvailability({
    site: { id: 'site', timezone: TZ, opening_hours: { thu: [{ start: '10:00', end: '18:00' }] }, scheduling_config: { ...DEFAULT_SCHEDULING_CONFIG, min_notice_min: 0 } },
    staff: [{ id: 'maria', working_hours: {}, timing: { duration_min: 60, buffer_before_min: 0, buffer_after_min: 0 }, busy: [], exceptions: occ.map((o) => ({ from: o.from, until: o.until })) }],
    siteExceptions: [],
    from: new Date('2026-10-22T05:00:00Z'),
    to: new Date('2026-10-23T05:00:00Z'),
    now: NOW,
  });
  const local = slots.map((s) => new Date(s.start_at.getTime() - 5 * 3600_000).toISOString().slice(11, 16));
  assert.ok(local.includes('13:00'), 'the usual lunch hour is bookable that day');
  assert.ok(!local.includes('14:00') && !local.includes('14:30'), 'the moved lunch is blocked');
  assert.ok(local.includes('15:00'));
});

test('an occurrence that already started is past: it cannot be edited or deleted', () => {
  const wed: ScheduleSeries = { ...lunchThu, id: 'lunch-wed', weekdays: [3] };
  const e = planEdit({ series: wed, overrides: [], scope: 'date', date: '2026-10-21', patch: { start_min: H(17), end_min: H(18) }, now: NOW, timeZone: TZ });
  assert.deepEqual(e, { ok: false, error: 'occurrence_started' });
  const d = planDelete({ series: wed, overrides: [], scope: 'following', date: '2026-10-21', now: NOW, timeZone: TZ });
  assert.deepEqual(d, { ok: false, error: 'occurrence_started' });
  // "Whole future series" cuts at the first occurrence not started yet: next Wednesday.
  assert.equal(firstOpenDate(wed, [], NOW, TZ), '2026-10-28');
});

test('"Esta y las siguientes" ENDS the row the day before and continues it — the past is untouched', () => {
  const overrides: SeriesOverride[] = [
    { series_id: 'training', occurrence_date: '2026-10-13', action: 'skip', start_min: null, end_min: null }, // past exclusion
    { series_id: 'training', occurrence_date: '2026-10-23', action: 'move', start_min: H(18), end_min: H(19) }, // before the cut
    { series_id: 'training', occurrence_date: '2026-11-03', action: 'skip', start_min: null, end_min: null }, // in scope
    { series_id: 'training', occurrence_date: '2026-11-06', action: 'move', start_min: H(9), end_min: H(10) }, // in scope
  ];
  const plan = planEdit({ series: training, overrides, scope: 'following', date: '2026-10-27', patch: { start_min: H(17), end_min: H(18, 30) }, now: NOW, timeZone: TZ });
  assert.ok(plan.ok);
  assert.equal(plan.cut, '2026-10-27');
  assert.ok(plan.summary.keepsBefore);
  const after = applyOpsInMemory([training], overrides, plan.ops);
  const old = after.series.find((s) => s.id === 'training')!;
  assert.equal(old.ends_on, '2026-10-26', 'old segment ends the day before');
  assert.equal(old.start_min, H(17, 30), 'old segment keeps its times');
  const cont = after.series.find((s) => s.id !== 'training')!;
  assert.equal(cont.starts_on, '2026-10-27');
  assert.equal(cont.start_min, H(17));
  // Before the cut: the past exclusion and the 23rd's own times are kept.
  const before = expandSeries(after.series, after.overrides, '2026-10-01', '2026-10-26', TZ);
  assert.ok(!before.some((o) => o.date === '2026-10-13'));
  assert.equal(before.find((o) => o.date === '2026-10-23')?.start_min, H(18));
  // In scope: the exclusion stays, the moved date adopts the new times.
  const later = expandSeries(after.series, after.overrides, '2026-10-27', '2026-11-10', TZ);
  assert.ok(!later.some((o) => o.date === '2026-11-03'), 'excluded date stays excluded');
  assert.equal(later.find((o) => o.date === '2026-11-06')?.start_min, H(17), 'moved date adopts the new times');
  assert.deepEqual(later.map((o) => o.date), ["2026-10-27", "2026-10-30", "2026-11-06", "2026-11-10"]); // 3 Nov excluded
});

test('"Toda la serie futura" cuts at the first not-started occurrence, never before', () => {
  const plan = planEdit({ series: training, overrides: [], scope: 'future', date: '2026-11-06', patch: { start_min: H(16), end_min: H(17) }, now: NOW, timeZone: TZ });
  assert.ok(plan.ok);
  assert.equal(plan.cut, '2026-10-23', 'Fri 23 is the first one that has not started');
  const after = applyOpsInMemory([training], [], plan.ops);
  const tue20 = expandSeries(after.series, after.overrides, '2026-10-20', '2026-10-20', TZ)[0];
  assert.equal(tue20.start_min, H(17, 30), 'Tue 20 (past) keeps its time');
});

test('delete with each scope: date → excluded, following → series ends, future of a not-yet-started series → removed', () => {
  const d1 = planDelete({ series: training, overrides: [], scope: 'date', date: '2026-10-23', now: NOW, timeZone: TZ });
  assert.ok(d1.ok);
  assert.equal(d1.ops[0].op, 'upsert_override');
  const d2 = planDelete({ series: training, overrides: [], scope: 'following', date: '2026-10-27', now: NOW, timeZone: TZ });
  assert.ok(d2.ok);
  assert.deepEqual(d2.ops, [{ op: 'end', id: 'training', ends_on: '2026-10-26' }]);
  const fresh: ScheduleSeries = { ...training, id: 'fresh', starts_on: '2026-11-03' };
  const d3 = planDelete({ series: fresh, overrides: [], scope: 'future', date: '2026-11-03', now: NOW, timeZone: TZ });
  assert.ok(d3.ok);
  assert.deepEqual(d3.ops, [{ op: 'delete', id: 'fresh' }]);
  // Deleted dates stop blocking and stop conflicting.
  const after = applyOpsInMemory([training], [], d2.ops);
  assert.equal(expandSeries(after.series, after.overrides, '2026-10-27', '2026-12-31', TZ).length, 0);
});

test('date scope refuses changes that are not a single date (days, end, reason)', () => {
  const r = planEdit({ series: training, overrides: [], scope: 'date', date: '2026-10-23', patch: { weekdays: [1] }, now: NOW, timeZone: TZ });
  assert.deepEqual(r, { ok: false, error: 'scope_not_allowed' });
});

test('a gap in weekly hours IS the usual break: splitDayRanges + open-start rows keep every past date', () => {
  const split = splitDayRanges([{ start: '10:00', end: '13:00' }, { start: '14:00', end: '18:00' }]);
  assert.deepEqual(split, { span: { start_min: H(10), end_min: H(18) }, gaps: [{ start_min: H(13), end_min: H(14) }] });
  // Saving the routine with the SAME break converts the gap without ending it.
  const same = planRoutine({ owner: { site_id: 'site', staff_id: 'maria' }, series: [], overrides: [], desired: { 4: [{ start_min: H(13), end_min: H(14) }] }, legacy: { 4: split.gaps }, now: NOW, timeZone: TZ });
  assert.ok(same.ok);
  assert.deepEqual(same.changedWeekdays, []);
  assert.equal(same.ops.length, 1);
  assert.equal((same.ops[0] as { fields: { starts_on: string | null } }).fields.starts_on, null);
});

test('changing the routine of a weekday ends the old break before its first future date and keeps exclusions', () => {
  const skip: SeriesOverride[] = [{ series_id: 'lunch-thu', occurrence_date: '2026-11-05', action: 'skip', start_min: null, end_min: null }];
  const r = planRoutine({ owner: { site_id: 'site', staff_id: 'maria' }, series: [lunchThu], overrides: skip, desired: { 4: [{ start_min: H(13, 30), end_min: H(14, 30) }] }, legacy: {}, now: NOW, timeZone: TZ });
  assert.ok(r.ok);
  assert.deepEqual(r.changedWeekdays, [4]);
  assert.equal(r.cuts[4], '2026-10-22');
  const after = applyOpsInMemory([lunchThu], skip, r.ops);
  const occ = expandSeries(after.series, after.overrides, '2026-10-15', '2026-11-12', TZ);
  assert.deepEqual(occ.map((o) => [o.date, o.start_min]), [
    ['2026-10-15', H(13)], // past: as it was
    ['2026-10-22', H(13, 30)],
    ['2026-10-29', H(13, 30)],
    ['2026-11-12', H(13, 30)], // 5 Nov stays excluded
  ]);
});

test('requires review: an appointment inside the moved break, or outside the hours, is flagged; one outside is not', () => {
  const ctx = {
    timeZone: TZ,
    siteHours: { thu: [{ start: '10:00', end: '18:00' }] },
    staffHours: {},
    breaks: [{ from: new Date('2026-10-22T19:00:00Z'), until: new Date('2026-10-22T20:00:00Z') }], // 14–15
    staffBlocks: [],
    siteBlocks: [],
  };
  assert.deepEqual(reviewReasons({ from: new Date('2026-10-22T19:15:00Z'), until: new Date('2026-10-22T20:00:00Z') }, ctx), ['break']);
  assert.deepEqual(reviewReasons({ from: new Date('2026-10-22T22:30:00Z'), until: new Date('2026-10-22T23:30:00Z') }, ctx), ['outside_hours']);
  assert.deepEqual(reviewReasons({ from: new Date('2026-10-22T18:00:00Z'), until: new Date('2026-10-22T19:00:00Z') }, ctx), []);
});
