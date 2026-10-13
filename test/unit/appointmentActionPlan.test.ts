import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appointmentActionPlan } from '../../web/lib/appointmentActionPlan.js';

/**
 * Which actions the appointment detail OFFERS, per role. `canModify` is what the agenda
 * page computes per appointment on the server (gateAppointment's own predicates) — the
 * second half of this file pins that wiring, so the UI never invents its own rule.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// canOperate: every client role and the agency may operate an agenda.
const OWN = { canOperate: true, canModify: true }; // a professional on its OWN appointment
const OTHER = { canOperate: true, canModify: false }; // a professional on SOMEONE ELSE's
const RECEPTION = { canOperate: true, canModify: true }; // setter / client owner / agency: any staff

test('own appointment (Sin confirmar): every authorised action is offered', () => {
  const p = appointmentActionPlan({ ...OWN, status: 'scheduled' });
  assert.deepEqual(p.transitions, ['confirmed', 'completed', 'no_show', 'cancelled']);
  assert.deepEqual(p.stateMenu, ['confirmed', 'no_show', 'cancelled'], 'the desktop menu leaves Completar to the footer');
  assert.equal(p.complete, true);
  assert.equal(p.primary, 'confirmed', 'phone primary = the next valid step');
  assert.equal(p.reschedule, true);
  assert.equal(p.readActivity, true);
});

test('own appointment (Confirmada): Completar is the primary, cancel/no-show still offered', () => {
  const p = appointmentActionPlan({ ...OWN, status: 'confirmed' });
  assert.deepEqual(p.transitions, ['completed', 'no_show', 'cancelled']);
  assert.equal(p.primary, 'completed');
  assert.equal(p.reschedule, true);
});

test("someone else's appointment: NO modification is offered, in any state", () => {
  for (const status of ['scheduled', 'confirmed', 'completed', 'cancelled', 'no_show']) {
    const p = appointmentActionPlan({ ...OTHER, status });
    assert.equal(p.allowed, false, status);
    assert.deepEqual(p.transitions, [], `${status}: no state change`);
    assert.deepEqual(p.stateMenu, [], `${status}: no state menu`);
    assert.equal(p.complete, false, `${status}: no Completar`);
    assert.equal(p.primary, null, `${status}: no primary`);
    assert.equal(p.reschedule, false, `${status}: no Reprogramar`);
    // The server refuses the activity read for it too (same gate), so it is not offered.
    assert.equal(p.readActivity, false, `${status}: no activity read the server would refuse`);
  }
});

test('reception / administration keep their current actions on ANY professional', () => {
  assert.deepEqual(appointmentActionPlan({ ...RECEPTION, status: 'scheduled' }), appointmentActionPlan({ ...OWN, status: 'scheduled' }));
  assert.deepEqual(appointmentActionPlan({ ...RECEPTION, status: 'confirmed' }).transitions, ['completed', 'no_show', 'cancelled']);
});

test('a closed appointment offers no transition, but the history stays readable to whoever may act', () => {
  for (const status of ['completed', 'cancelled', 'no_show']) {
    const p = appointmentActionPlan({ ...OWN, status });
    assert.deepEqual(p.transitions, []);
    assert.equal(p.reschedule, false);
    assert.equal(p.readActivity, true);
  }
});

test('a login that cannot operate the agenda gets nothing, whatever the per-appointment flag says', () => {
  const p = appointmentActionPlan({ canOperate: false, canModify: true, status: 'scheduled' });
  assert.equal(p.allowed, false);
  assert.deepEqual(p.transitions, []);
});

test('canModify comes from the SERVER, with exactly the predicates of the appointment gate', () => {
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(
    page.includes('canOperateScheduling(scope) && canAccessSchedulingSite(scope, a.site_id) && canAccessSchedulingStaff(scope, a.staff_id)'),
    'the page computes can_modify per appointment from the real access predicates',
  );
  const actions = read('web/lib/schedulingActions.ts');
  const gate = actions.slice(actions.indexOf('async function gateAppointment'), actions.indexOf('function agendaPath'));
  for (const p of ['canAccessSchedulingSite(ctx.scope, appointment.site_id)', 'canAccessSchedulingStaff(ctx.scope, appointment.staff_id)']) {
    assert.ok(gate.includes(p), `the server gate still checks ${p} — the UI flag mirrors it`);
  }
  assert.ok(actions.includes('if (!resolved.ok || !canOperateScheduling(resolved.context.scope)) return null;'), 'and canOperateScheduling');
  // Every write and the activity read still go through that gate (the UI hides; the server decides).
  assert.ok(/async function transition\([\s\S]*?const gated = await gateAppointment\(clientId, appointmentId\);/.test(actions), 'state changes are gated');
  assert.ok(/export async function rescheduleAppointmentAction\([\s\S]*?gateAppointment\(/.test(actions), 'reschedule is gated');
  assert.ok(/export async function listAppointmentActivityAction\([\s\S]*?gateAppointment\(/.test(actions), 'the activity read is gated');
});

test('both detail surfaces decide from the shared plan — no separate visual rule', () => {
  const view = read('web/components/scheduling/AgendaView.tsx');
  assert.ok(view.includes('canModify={selected.can_modify}'), 'the agenda hands the server flag to the detail');
  const panel = read('web/components/scheduling/agenda/AppointmentPanel.tsx');
  const sheet = read('web/components/scheduling/mobile/MobileAppointmentSheet.tsx');
  for (const [name, src] of [['desktop panel', panel], ['phone sheet', sheet]] as const) {
    assert.ok(src.includes('appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status })'), `${name} uses the plan`);
    assert.ok(!/props\.canOperate && live/.test(src), `${name} no longer decides from canOperate alone`);
  }
  assert.ok(panel.includes('canModify={props.canModify}'), 'the desktop panel passes it to the phone sheet');
  assert.ok(sheet.includes('if (!plan.readActivity) return;'), 'the phone does not request an activity read the server would refuse');
  // Visibility is unchanged: the page still loads the whole site for a staff login.
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(page.includes('listAppointments(tenantId, { siteId: site.id, from: rangeStart, to: rangeEnd, clientId: client.id })'), 'the same site-wide read');
});
