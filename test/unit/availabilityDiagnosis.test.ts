import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { diagnoseDay, fmtSpans, nextDateOf } from '../../web/lib/availabilityDiagnosis.js';

/**
 * Finding E — «Diagnóstico de disponibilidad» read only `opening_hours[dow][0]`: a site open
 * 09–13 and 14–19 showed "Abierta de 09:00 a 13:00" and hid the afternoon, and no break
 * was shown. These pin every range, the gaps as breaks, and break series.
 */
const SPLIT = { mon: [{ start: '09:00', end: '13:00' }, { start: '14:00', end: '19:00' }] };

test('every range of the day is shown, and the gap between them is a break', () => {
  const d = diagnoseDay({ dow: 'mon', date: '2026-10-26', siteHours: SPLIT, staff: [], breaks: [] });
  assert.equal(fmtSpans(d.siteSpans), '09:00–13:00 · 14:00–19:00');
  assert.equal(fmtSpans(d.siteBreaks), '13:00–14:00');
});

test('a professional: site ∩ own hours, minus the site break, their gaps and their break series', () => {
  const d = diagnoseDay({
    dow: 'mon',
    date: '2026-10-26',
    siteHours: SPLIT,
    staff: [
      { id: 'a', name: 'Ana', active: true, working_hours: { mon: [{ start: '12:00', end: '19:00' }] } },
      { id: 'l', name: 'Luis', active: true, working_hours: null },
      { id: 'x', name: 'Inactiva', active: false, working_hours: null },
      { id: 'm', name: 'Marta', active: true, working_hours: { tue: [{ start: '10:00', end: '18:00' }] } },
    ],
    breaks: [
      { staffId: 'a', weekdays: [1], start: '15:00', end: '15:45', startsOn: null, endsOn: null },
      // Ended before the date read: not this Monday's break.
      { staffId: 'l', weekdays: [1], start: '10:00', end: '11:00', startsOn: null, endsOn: '2026-10-01' },
    ],
  });
  const ana = d.working.find((w) => w.id === 'a');
  assert.equal(fmtSpans(ana!.spans), '12:00–13:00 · 14:00–15:00 · 15:45–19:00');
  assert.equal(fmtSpans(ana!.breaks), '15:00–15:45');
  const luis = d.working.find((w) => w.id === 'l');
  assert.equal(luis!.inherits, true);
  assert.equal(fmtSpans(luis!.spans), '09:00–13:00 · 14:00–19:00', 'inherits both ranges; an ended series does not apply');
  assert.deepEqual(d.working.map((w) => w.id).sort(), ['a', 'l'], 'inactive and off-day professionals are not working');
});

test('a site break series in effect is a break of the whole site', () => {
  const d = diagnoseDay({
    dow: 'mon',
    date: '2026-10-26',
    siteHours: { mon: [{ start: '09:00', end: '19:00' }] },
    staff: [{ id: 'l', name: 'Luis', active: true, working_hours: null }],
    breaks: [{ staffId: null, weekdays: [1], start: '13:00', end: '14:00', startsOn: '2026-10-01', endsOn: null }],
  });
  assert.equal(fmtSpans(d.siteBreaks), '13:00–14:00');
  assert.equal(fmtSpans(d.working[0].spans), '09:00–13:00 · 14:00–19:00');
});

test('nextDateOf reads the weekday from today, today included', () => {
  assert.equal(nextDateOf('thu', '2026-10-22'), '2026-10-22');
  assert.equal(nextDateOf('mon', '2026-10-22'), '2026-10-26');
});

test('the component no longer reads only the first range', () => {
  const src = readFileSync(new URL('../../web/components/scheduling/AdminPanel.tsx', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function WhyNothingAvailable'), src.indexOf('export type Run'));
  assert.ok(!/\[dow\]\?\.\[0\]/.test(body), 'no opening_hours[dow][0]');
  assert.match(body, /diagnoseDay\(/);
});
