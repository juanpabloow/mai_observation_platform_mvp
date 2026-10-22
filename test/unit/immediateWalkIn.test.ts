import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { IMMEDIATE_WINDOW_MIN, immediateWindowMin, isImmediateStart } from '../../src/scheduling/immediate.js';

/**
 * The immediate walk-in window (src/scheduling/immediate.ts) and the contract that ONLY the
 * agenda's walk-in can ask for it. Behaviour end to end: test/integration/immediateWalkIn.test.ts.
 */
const NOW = new Date('2026-10-22T20:07:00.000Z');
const plus = (min: number) => new Date(NOW.getTime() + min * 60_000);

test('the window is at least 15 min, or one slot of the grid when it is coarser', () => {
  assert.equal(IMMEDIATE_WINDOW_MIN, 15);
  assert.equal(immediateWindowMin(5), 15);
  assert.equal(immediateWindowMin(15), 15);
  assert.equal(immediateWindowMin(30), 30);
  assert.equal(immediateWindowMin(Number.NaN), 15);
});

test('«ahora» is [now − 1 min, now + window]; later today, earlier or another day is not', () => {
  assert.equal(isImmediateStart(plus(0), NOW, 15), true);
  assert.equal(isImmediateStart(plus(8), NOW, 15), true);
  assert.equal(isImmediateStart(plus(15), NOW, 15), true);
  assert.equal(isImmediateStart(plus(-1), NOW, 15), true, 'one minute of clock skew');
  assert.equal(isImmediateStart(plus(16), NOW, 15), false);
  assert.equal(isImmediateStart(plus(-2), NOW, 15), false, 'a start in the past');
  assert.equal(isImmediateStart(plus(25), NOW, 30), true);
  assert.equal(isImmediateStart(plus(180), NOW, 30), false, 'later today');
  assert.equal(isImmediateStart(plus(24 * 60), NOW, 30), false, 'tomorrow');
});

const src = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the bot API and the public page never set the exception; only the walk-in action does', () => {
  for (const p of ['web/app/api/scheduling/v1/appointments/route.ts', 'web/app/api/booking/[slug]/route.ts']) {
    const s = src(p);
    assert.ok(!/immediateWalkIn|ignoreMinNotice|\bimmediate\b|isImmediateStart/.test(s), `${p} cannot ask for «ahora»`);
  }
  const action = src('web/lib/schedulingActions.ts');
  assert.match(action, /immediateWalkIn: Boolean\(input\.walkIn && input\.immediate\)/, 'only a walk-in, and only when asked');
  assert.match(action, /gate\(clientId, "agenda\.book"\)/, 'behind the agenda booking permission');
  const booking = src('src/scheduling/booking.ts');
  assert.match(booking, /ignoreMinNotice: input\.immediateWalkIn === true/);
  assert.match(booking, /input\.immediateWalkIn && !isImmediateStart\(/, 'the server re-checks the start is now');
});

test('the panel sends «ahora» only for an immediate start and books a later time only once accepted', () => {
  const panel = src('web/components/scheduling/agenda/WalkInPanel.tsx');
  assert.match(panel, /immediate: slot === nowSlot/);
  assert.match(panel, /const slot = nowSlot \?\? \(laterAccepted \? laterSlot : null\)/);
  assert.match(panel, /No hay espacio ahora/);
  assert.match(panel, /No se reserva hasta que lo confirmes/);
});
