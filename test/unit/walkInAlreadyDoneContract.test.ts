import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Atención sin cita · Esta atención ya se realizó»: the SAME form, one option; the server decides.
const r = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the walk-in form offers it, shows only ended starts of today, and asks before saving', () => {
  const panel = r('web/components/scheduling/agenda/WalkInPanel.tsx');
  assert.ok(panel.includes('Esta atención ya se realizó'));
  assert.ok(panel.includes('past: "1"') && panel.includes('from: siteMidnight(today, tz).toISOString()'), 'starts of today from the engine (past=1)');
  assert.ok(panel.includes('onClick={() => setConfirming(true)}') && panel.includes('Confirmar registro'), 'explicit confirmation before it is saved');
  assert.ok(panel.includes('alreadyDone: true') && !/alreadyDone: true[\s\S]{0,200}immediate: true/.test(panel), 'never together with «ahora»');
  assert.ok(panel.includes('el cobro queda pendiente y no se envía ningún mensaje'), 'says what it does not do');
  assert.ok(panel.includes('No se cambió ninguna cita.'), 'conflicts are shown, nothing else is changed');
});

test('the server gates it: agenda walk-ins only, today, ended, no overlap, created and completed atomically', () => {
  const actions = r('web/lib/schedulingActions.ts');
  assert.ok(actions.includes('(input.alreadyDone && (!input.walkIn || input.immediate || input.initialStatus))'), 'walk-in only, never «ahora»');
  assert.ok(actions.includes('pastWalkIn: Boolean(input.walkIn && input.alreadyDone)'));
  assert.ok(!actions.includes('transition("completed", clientId, id'), 'no second, separate «complete» step that could fail half-way');
  assert.ok(actions.includes('if (row?.status !== "completed") return { ok: false'), 'anything but completed is reported');
  const engine = r('src/scheduling/booking.ts');
  assert.ok(engine.includes("if (input.pastWalkIn && (input.origin !== 'walk_in' || input.immediateWalkIn || input.startAt.getTime() >= now.getTime()))"));
  assert.ok(engine.includes('if (day(input.startAt) !== day(now))'), 'today at the site only');
  assert.ok(engine.includes('if (serviceEnd.getTime() > now.getTime())'), 'the whole service ended');
  assert.ok(engine.includes("error: 'past_overlap'"), 'an overlap with any appointment of the professional is refused');
  assert.ok(engine.includes("pg_advisory_xact_lock(hashtext($1))`, [`past-walk-in:${chosenStaffId}`]") , 'serialized per professional, before any write');
  assert.ok(engine.includes("const done = await setStatus(client, input.tenantId, appt.id, 'completed');"), 'completed in the SAME transaction as the insert');
  // Nothing outside the agenda can set it: the bot route and the public page never pass it.
  for (const f of ['web/app/api/scheduling/v1/appointments/route.ts', 'web/app/api/booking/[slug]/route.ts']) {
    assert.ok(!r(f).includes('pastWalkIn') && !r(f).includes('alreadyDone'), f);
  }
});
