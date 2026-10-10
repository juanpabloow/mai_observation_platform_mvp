import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildDay, groupWeek, untilLabel, type MAppt, type MBlock } from '../../web/lib/mobileAgenda.js';

/** BEHAVIOUR of the phone agenda's list logic. Bogotá = UTC-5, no DST. */
const TZ = 'America/Bogota';
const at = (day: string, hm: string) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), h + 5, m)).toISOString();
};
const appt = (id: string, day: string, hm: string, status = 'confirmed', staff = 'ana', dur = 30): MAppt => ({
  id,
  staff_id: staff,
  status,
  start_at: at(day, hm),
  service_end_at: new Date(new Date(at(day, hm)).getTime() + dur * 60000).toISOString(),
});
const block = (id: string, staff: string | null, day: string, from: string, to: string): MBlock => ({ id, staff_id: staff, starts_at: at(day, from), ends_at: at(day, to), reason: null });
const DAY = '2026-10-09';

test('today: chronological, a "now" line at the current minute, and the next live appointment marked', () => {
  const appts = [appt('b', DAY, '10:30'), appt('a', DAY, '09:00', 'completed'), appt('c', DAY, '13:30', 'cancelled'), appt('d', DAY, '16:00', 'scheduled')];
  const { items, nextId } = buildDay(appts, [block('x', null, DAY, '13:00', '14:00')], DAY, TZ, new Date(at(DAY, '10:12')));
  assert.deepEqual(items.map((i) => (i.kind === 'appt' ? i.appt.id : i.kind)), ['a', 'now', 'b', 'block', 'c', 'd']);
  assert.equal(nextId, 'b', 'the first live appointment after now');
  assert.ok(items.some((i) => i.kind === 'appt' && i.appt.id === 'b' && i.isNext));
});

test('a cancelled or completed appointment is never "next"', () => {
  const appts = [appt('c', DAY, '10:30', 'cancelled'), appt('d', DAY, '11:00', 'completed'), appt('e', DAY, '12:00', 'scheduled')];
  assert.equal(buildDay(appts, [], DAY, TZ, new Date(at(DAY, '10:00'))).nextId, 'e');
});

test('another day: no "now" line and no "next"', () => {
  const r = buildDay([appt('a', '2026-10-12', '09:00')], [], '2026-10-12', TZ, new Date(at(DAY, '10:00')));
  assert.ok(!r.items.some((i) => i.kind === 'now'));
  assert.equal(r.nextId, null);
});

test("blocks: site-wide always; a professional's only when that professional is in view", () => {
  const blocks = [block('site', null, DAY, '13:00', '14:00'), block('ana', 'ana', DAY, '15:00', '16:00'), block('beto', 'beto', DAY, '17:00', '18:00')];
  const all = buildDay([], blocks, DAY, TZ, new Date(at('2026-10-01', '09:00')));
  assert.equal(all.blockCount, 3, 'no filter → every block of the day');
  const onlyAna = buildDay([], blocks, DAY, TZ, new Date(at('2026-10-01', '09:00')), { staffInView: ['ana'] });
  assert.deepEqual(onlyAna.items.map((i) => (i.kind === 'block' ? i.block.id : i.kind)), ['site', 'ana']);
});

test('a block spanning midnight is clipped to the day', () => {
  const overnight: MBlock = { id: 'n', staff_id: null, starts_at: at(DAY, '22:00'), ends_at: at('2026-10-10', '03:00'), reason: null };
  const today = buildDay([], [overnight], DAY, TZ, new Date(at('2026-10-01', '09:00'))).items[0];
  const next = buildDay([], [overnight], '2026-10-10', TZ, new Date(at('2026-10-01', '09:00'))).items[0];
  assert.ok(today.kind === 'block' && today.from === 22 * 60 && today.to === 24 * 60);
  assert.ok(next.kind === 'block' && next.from === 0 && next.to === 3 * 60);
});

test('week: at most 3 rows per day, the rest behind "Ver las N citas"; never hides a single row', () => {
  const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-11'];
  const appts = [
    ...['09:00', '10:00', '11:00', '12:00', '13:00'].map((t, i) => appt(`m${i}`, days[0], t)), // 5 → 3 + 2 hidden
    ...['09:00', '10:00', '11:00', '12:00'].map((t, i) => appt(`t${i}`, days[1], t)), // 4 → all 4 (hiding 1 is pointless)
  ];
  const g = groupWeek(appts, days, TZ, (d) => d === '2026-10-11');
  assert.deepEqual([g[0].shown.length, g[0].hidden], [3, 2]);
  assert.deepEqual([g[1].shown.length, g[1].hidden], [4, 0]);
  assert.equal(g[2].appts.length, 0);
  assert.equal(g[3].closed, true);
  // Nothing is lost: shown + hidden = every appointment of the day.
  for (const d of g) assert.equal(d.shown.length + d.hidden, d.appts.length);
});

test('countdown labels', () => {
  const t0 = Date.UTC(2026, 9, 9, 15, 12);
  assert.equal(untilLabel(t0, t0 + 18 * 60000), 'en 18 min');
  assert.equal(untilLabel(t0, t0 + 60 * 60000), 'en 1 h');
  assert.equal(untilLabel(t0, t0 + 125 * 60000), 'en 2 h 5 min');
});
