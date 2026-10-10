import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { blockSpanOn, dayBlocks, hourState, type AgendaBlock } from '../../web/lib/agendaBlocks.js';

/**
 * BEHAVIOUR of the agenda's blocked-time helpers — what the hour rows, phone/tablet
 * lists and week grid draw. Bogotá is UTC-5 all year (no DST), so 13:00 local = 18:00Z.
 */
const TZ = 'America/Bogota';
const DAY = '2026-10-09';
const at = (hm: string) => `${DAY}T${String(Number(hm.slice(0, 2)) + 5).padStart(2, '0')}:${hm.slice(3)}:00.000Z`;
const block = (id: string, staff: string | null, from: string, to: string, reason: string | null = null): AgendaBlock => ({
  id,
  staff_id: staff,
  starts_at: at(from),
  ends_at: at(to),
  reason,
});
const STAFF = ['ana', 'beto', 'caro'];
const names = new Map([
  ['ana', 'Ana'],
  ['beto', 'Beto'],
  ['caro', 'Caro'],
]);
const day = (bs: AgendaBlock[], staffFilter: string | null = null) => dayBlocks(bs, DAY, TZ, { staffNames: names, staffFilter });

test('ONE professional blocked: the hour stays bookable with the others (partial, not blocked)', () => {
  const blocks = day([block('b1', 'ana', '13:00', '14:00', 'Almuerzo')]);
  assert.equal(hourState(blocks, 13, STAFF), 'partial');
  assert.equal(hourState(blocks, 12, STAFF), 'open', 'the hour before is untouched');
  assert.equal(blocks[0].label, 'Bloqueado · Ana · Almuerzo', 'the indicator names who and why');
  assert.equal(blocks[0].when, '13:00 – 14:00');
});

test('EVERY professional blocked for the whole hour: blocked', () => {
  const blocks = day(STAFF.map((s) => block(`b-${s}`, s, '13:00', '14:00')));
  assert.equal(hourState(blocks, 13, STAFF), 'blocked');
  // …but not if one of them is only blocked for part of it.
  const almost = day([block('a', 'ana', '13:00', '14:00'), block('b', 'beto', '13:00', '14:00'), block('c', 'caro', '13:00', '13:45')]);
  assert.equal(hourState(almost, 13, STAFF), 'partial');
});

test('a WHOLE-SITE block covering the hour blocks it for everyone', () => {
  const blocks = day([block('site', null, '13:00', '14:00', 'Reunión de equipo')]);
  assert.equal(hourState(blocks, 13, STAFF), 'blocked');
  assert.equal(hourState(blocks, 14, STAFF), 'open', 'ends exactly at 14:00 — the next hour is free');
  assert.equal(blocks[0].label, 'Bloqueado · toda la sede · Reunión de equipo');
  // A site block also blocks a day where nobody is scheduled to work.
  assert.equal(hourState(blocks, 13, []), 'blocked');
});

test('a PARTIAL 15-minute block never presents the whole hour as unavailable', () => {
  const site15 = day([block('s', null, '13:15', '13:30')]);
  assert.equal(hourState(site15, 13, STAFF), 'partial', 'even site-wide, 45 free minutes remain');
  const ana15 = day([block('a', 'ana', '09:45', '10:00')]);
  assert.equal(hourState(ana15, 9, STAFF), 'partial');
  assert.equal(hourState(ana15, 10, STAFF), 'open', 'a block ending on the hour does not leak into the next');
});

test('pieces that TOGETHER cover the hour block it; a gap keeps it partial', () => {
  const joined = day([block('x', null, '13:00', '13:30'), block('y', null, '13:30', '14:00')]);
  assert.equal(hourState(joined, 13, STAFF), 'blocked');
  const gap = day([block('x', null, '13:00', '13:25'), block('y', null, '13:30', '14:00')]);
  assert.equal(hourState(gap, 13, STAFF), 'partial');
  // Own + site-wide pieces combine per professional.
  const mixed = day([block('own', 'ana', '13:00', '13:30'), block('site', null, '13:30', '14:00')]);
  assert.equal(hourState(mixed, 13, ['ana']), 'blocked', "Ana's own half + the site's half = Ana's whole hour");
  assert.equal(hourState(mixed, 13, STAFF), 'partial', 'the others still have 13:00–13:30');
});

test('a barber FILTER keeps that barber and site-wide blocks, and only that barber counts', () => {
  const raw = [block('a', 'ana', '13:00', '14:00'), block('b', 'beto', '15:00', '16:00'), block('s', null, '17:00', '18:00')];
  const forAna = day(raw, 'ana');
  assert.deepEqual(forAna.map((b) => b.id), ['a', 's'], "Beto's block is not in Ana's day");
  assert.equal(hourState(forAna, 13, ['ana']), 'blocked', 'with only Ana in view, her block closes the hour');
  assert.equal(hourState(day(raw, 'beto'), 13, ['beto']), 'open');
});

test('a block spanning midnight is clipped to each site day', () => {
  const overnight: AgendaBlock = { id: 'n', staff_id: null, starts_at: '2026-10-10T03:00:00.000Z', ends_at: '2026-10-10T08:00:00.000Z', reason: null }; // 22:00 → 03:00 local
  assert.deepEqual(blockSpanOn(overnight, DAY, TZ), { sMin: 22 * 60, eMin: 24 * 60, from: 22 * 60, to: 24 * 60 });
  assert.deepEqual(blockSpanOn(overnight, '2026-10-10', TZ), { sMin: 0, eMin: 3 * 60, from: 0, to: 3 * 60 });
  assert.equal(blockSpanOn(overnight, '2026-10-11', TZ), null);
  const allDay: AgendaBlock = { id: 'd', staff_id: 'caro', starts_at: '2026-10-09T05:00:00.000Z', ends_at: '2026-10-10T05:00:00.000Z', reason: 'Vacaciones' };
  assert.equal(day([allDay])[0].when, 'Todo el día');
});
