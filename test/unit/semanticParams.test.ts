import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeName, matchByName } from '../../src/scheduling/nameMatch.js';
import { parseClockTime, combineLocalDayTime } from '../../src/scheduling/timezone.js';

/** Pure primitives behind the semantic machine-API params (no DB). */

test('normalizeName is case/accent/whitespace insensitive', () => {
  const k = normalizeName('Corte de Cabello');
  assert.equal(normalizeName('corte de cabello'), k);
  assert.equal(normalizeName('  CÓRTE   de  cabello '), k);
  assert.equal(normalizeName('CORTE DE CABELLO'), k);
  assert.equal(normalizeName('Café con Leña'), normalizeName('cafe con lena'));
});

test('matchByName: exact-ish → ok, none → not_found (valid list), 2+ → ambiguous', () => {
  const rows = [{ id: 's1', name: 'Corte' }, { id: 's2', name: 'Barba' }];
  assert.deepEqual(matchByName(rows, 'corte'), { status: 'ok', id: 's1', name: 'Corte' });
  assert.deepEqual(matchByName(rows, 'CÓRTE'), { status: 'ok', id: 's1', name: 'Corte' });
  const nf = matchByName(rows, 'manicure');
  assert.equal(nf.status, 'not_found');
  if (nf.status === 'not_found') assert.deepEqual(nf.valid, ['Barba', 'Corte']);
  const amb = matchByName([{ id: 'a', name: 'Corte' }, { id: 'b', name: 'corte' }], 'corte');
  assert.equal(amb.status, 'ambiguous');
  if (amb.status === 'ambiguous') assert.deepEqual(amb.candidates.map((c) => c.id).sort(), ['a', 'b']);
  assert.equal(matchByName(rows, '   ').status, 'not_found'); // blank is not a silent match
});

test('parseClockTime accepts 24h and 12h forms, rejects ambiguous/out-of-range', () => {
  const ok: Array<[string, string]> = [
    ['14:30', '14:30'], ['9:00', '09:00'], ['09:05', '09:05'], ['00:00', '00:00'], ['23:59', '23:59'],
    ['9 am', '09:00'], ['9:00am', '09:00'], ['9AM', '09:00'], ['5 pm', '17:00'], ['5:30 p.m.', '17:30'],
    ['12 am', '00:00'], ['12 pm', '12:00'], ['12:15 am', '00:15'], ['11 pm', '23:00'],
  ];
  for (const [input, want] of ok) assert.equal(parseClockTime(input), want, `parseClockTime(${JSON.stringify(input)})`);
  for (const bad of ['25:00', '5', 'noon', '13 pm', '0 am', '9:60', '', '  ', 'abc', '24:00']) {
    assert.equal(parseClockTime(bad), null, `parseClockTime(${JSON.stringify(bad)}) should be null`);
  }
});

test('combineLocalDayTime is DST-correct (America/New_York) and rejects impossible dates', () => {
  // Same wall-clock, different UTC offset across the DST boundary — proves the server
  // handles the conversion the caller no longer does.
  const winter = combineLocalDayTime('2026-01-15', '10:00', 'America/New_York'); // EST = UTC-5
  assert.ok(winter && winter.getUTCHours() === 15 && winter.getUTCMinutes() === 0, `winter EST → 15:00Z (got ${winter?.toISOString()})`);
  const summer = combineLocalDayTime('2026-07-15', '10:00', 'America/New_York'); // EDT = UTC-4
  assert.ok(summer && summer.getUTCHours() === 14, `summer EDT → 14:00Z (got ${summer?.toISOString()})`);
  // 12h form + a fixed-offset zone.
  const bogota = combineLocalDayTime('2026-07-15', '9:00 am', 'America/Bogota'); // UTC-5
  assert.ok(bogota && bogota.getUTCHours() === 14);
  assert.equal(combineLocalDayTime('2026-02-30', '10:00', 'America/New_York'), null, 'impossible date → null');
  assert.equal(combineLocalDayTime('nope', '10:00', 'America/Bogota'), null);
  assert.equal(combineLocalDayTime('2026-07-15', 'nope', 'America/Bogota'), null);
});
