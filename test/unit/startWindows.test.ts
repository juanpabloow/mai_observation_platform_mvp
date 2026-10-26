import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeStartWindows } from '../../web/lib/startWindows.js';
import { localWallClockToUtc } from '../../src/scheduling/timezone.js';

/**
 * AV-1 — start-window collapsing (pure). Valid starts → contiguous runs; `until` is the LAST
 * start, never a block end; a gap wider than one step splits the run; "any staff" (staffName=null)
 * is the union; days are grouped; the defensive cap sets a truncation flag.
 */
const TZ = 'America/Bogota';
const LOCALE = 'es-CO';
const STEP = 15 * 60_000;
const at = (d: string, hhmm: string) => localWallClockToUtc(`${d}T${hhmm}`, TZ);
const D = '2026-10-27';

test('a contiguous run collapses to one window; until is the LAST start, not a block end', () => {
  const starts = [at(D, '10:00'), at(D, '10:15'), at(D, '10:30'), at(D, '10:45')];
  const { windows, truncated } = computeStartWindows(starts, TZ, LOCALE, STEP, 'Falla', 1000);
  assert.equal(truncated, false);
  assert.equal(windows.length, 1);
  const w = windows[0];
  assert.equal(w.from, '10:00');
  assert.equal(w.until, '10:45', 'until = last valid start');
  assert.equal(w.step_minutes, 15);
  assert.equal(w.staff_name, 'Falla');
  assert.equal(w.day, D);
  assert.equal(w.first_start_at, at(D, '10:00').toISOString());
  assert.equal(w.until_start_at, at(D, '10:45').toISOString());
  assert.ok(w.from_label.length > 0 && w.until_label.length > 0, 'read-aloud labels present');
});

test('a gap wider than one step splits the run (an appointment/break removes the starts between)', () => {
  // Free 10:00–… with a booking that removes 11:00 and 11:15 → last start before it is 10:45,
  // starts resume at 11:30.
  const starts = [
    at(D, '10:00'), at(D, '10:15'), at(D, '10:30'), at(D, '10:45'),
    at(D, '11:30'), at(D, '11:45'),
  ];
  const { windows } = computeStartWindows(starts, TZ, LOCALE, STEP, 'Falla', 1000);
  assert.equal(windows.length, 2);
  assert.deepEqual([windows[0].from, windows[0].until], ['10:00', '10:45']);
  assert.deepEqual([windows[1].from, windows[1].until], ['11:30', '11:45']);
});

test('"any staff" union has no staff_name', () => {
  const starts = [at(D, '09:00'), at(D, '09:15')];
  const { windows } = computeStartWindows(starts, TZ, LOCALE, STEP, null, 1000);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].staff_name, null);
});

test('a lone start is a one-tick window (from === until)', () => {
  const { windows } = computeStartWindows([at(D, '16:15')], TZ, LOCALE, STEP, 'Falla', 1000);
  assert.equal(windows.length, 1);
  assert.deepEqual([windows[0].from, windows[0].until], ['16:15', '16:15']);
});

test('starts on different days are grouped per day, chronologically', () => {
  const D2 = '2026-10-28';
  const starts = [at(D2, '09:00'), at(D, '18:00'), at(D, '18:15')];
  const { windows } = computeStartWindows(starts, TZ, LOCALE, STEP, 'Falla', 1000);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].day, D);
  assert.deepEqual([windows[0].from, windows[0].until], ['18:00', '18:15']);
  assert.equal(windows[1].day, D2);
  assert.deepEqual([windows[1].from, windows[1].until], ['09:00', '09:00']);
});

test('duplicate starts are de-duped (union may pass the same time once per staff)', () => {
  const starts = [at(D, '10:00'), at(D, '10:00'), at(D, '10:15')];
  const { windows } = computeStartWindows(starts, TZ, LOCALE, STEP, null, 1000);
  assert.equal(windows.length, 1);
  assert.deepEqual([windows[0].from, windows[0].until], ['10:00', '10:15']);
});

test('the defensive cap drops extra windows and flags truncation (never a silent cut)', () => {
  // Three separate one-tick windows (gaps between them), cap at 2.
  const starts = [at(D, '09:00'), at(D, '12:00'), at(D, '15:00')];
  const { windows, truncated } = computeStartWindows(starts, TZ, LOCALE, STEP, 'Falla', 2);
  assert.equal(windows.length, 2);
  assert.equal(truncated, true);
});

test('step other than 15 is reflected and governs contiguity', () => {
  const step30 = 30 * 60_000;
  // 09:00 and 09:15 are only 15 apart → NOT contiguous at a 30-min step → two windows.
  const { windows } = computeStartWindows([at(D, '09:00'), at(D, '09:30'), at(D, '10:00')], TZ, LOCALE, step30, 'Falla', 1000);
  assert.equal(windows.length, 1, '09:00→10:00 at 30-min step is contiguous');
  assert.equal(windows[0].step_minutes, 30);
  assert.deepEqual([windows[0].from, windows[0].until], ['09:00', '10:00']);
});
