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

// canOperate: every client role and the agency may operate an agenda. The appointment
// has already started (the start rule has its own test below).
const START = '2026-10-21T15:00:00.000Z';
const STARTED = { startAt: START, now: Date.parse(START) + 30 * 60_000 };
const OWN = { canOperate: true, canModify: true, ...STARTED }; // a professional on its OWN appointment
const OTHER = { canOperate: true, canModify: false, ...STARTED }; // a professional on SOMEONE ELSE's
const RECEPTION = { canOperate: true, canModify: true, ...STARTED }; // setter / client owner / agency: any staff

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
  const p = appointmentActionPlan({ canOperate: false, canModify: true, status: 'scheduled', ...STARTED });
  assert.equal(p.allowed, false);
  assert.deepEqual(p.transitions, []);
});

test('canModify comes from the SERVER, with exactly the predicates of the appointment gate', () => {
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(
    page.includes('canBook && canAccessSchedulingSite(scope, a.site_id) && canAccessSchedulingStaff(scope, a.staff_id)'),
    'the page computes can_modify per appointment from the real access predicates',
  );
  const actions = read('web/lib/schedulingActions.ts');
  const gate = actions.slice(actions.indexOf('async function gateAppointment'), actions.indexOf('function agendaPath'));
  for (const p of ['canAccessSchedulingSite(ctx.scope, appointment.site_id)', 'canAccessSchedulingStaff(ctx.scope, appointment.staff_id)']) {
    assert.ok(gate.includes(p), `the server gate still checks ${p} — the UI flag mirrors it`);
  }
  assert.ok(actions.includes('return gateClientModule(clientId, "scheduling", permission, GENERIC_GATE);'), 'and the agenda permission (agenda.book for writes)');
  // Every write and the activity read still go through that gate (the UI hides; the server decides).
  assert.ok(/async function transition\([\s\S]*?const gated = await gateAppointment\(clientId, appointmentId, "agenda\.book"\);/.test(actions), 'state changes are gated (agenda.book)');
  assert.ok(/export async function rescheduleAppointmentAction\([\s\S]*?gateAppointment\(/.test(actions), 'reschedule is gated');
  assert.ok(/export async function listAppointmentActivityAction\([\s\S]*?gateAppointment\(/.test(actions), 'the activity read is gated');
});

test('both detail surfaces decide from the shared plan — no separate visual rule', () => {
  const view = read('web/components/scheduling/AgendaView.tsx');
  assert.ok(view.includes('canModify={appt.can_modify}'), 'the agenda hands the server flag to the detail');
  const panel = read('web/components/scheduling/agenda/AppointmentPanel.tsx');
  const card = read('web/components/scheduling/agenda/AppointmentCard.tsx');
  const sheet = read('web/components/scheduling/mobile/MobileAppointmentSheet.tsx');
  // ONE plan, computed once, and ONE card body framed by the desktop panel and the phone sheet.
  assert.ok(panel.includes('appointmentActionPlan({ canOperate: props.canOperate, canModify: props.canModify, status: appt.status, startAt: appt.start_at, now })'), 'the panel computes the plan');
  assert.ok(panel.includes('plan={plan}') && panel.includes('<MobileAppointmentSheet parts={parts}'), 'both frames get the same card from that plan');
  for (const [name, src] of [['card', card], ['phone sheet', sheet]] as const) {
    assert.ok(!src.includes('appointmentActionPlan('), `${name} does not decide on its own`);
    assert.ok(!/props\.canOperate && live/.test(src), `${name} no longer decides from canOperate alone`);
  }
  assert.ok(card.includes('{plan.readActivity ? <ActivitySection'), 'no activity read the server would refuse');
  // Visibility is unchanged: the page still loads the whole site for a staff login.
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.ok(page.includes('listAppointments(tenantId, { siteId: site.id, from: rangeStart, to: rangeEnd, clientId: client.id })'), 'the same site-wide read');
});

test('the review link is offered ONLY for a completed appointment this login may act on', () => {
  assert.equal(appointmentActionPlan({ ...OWN, status: 'completed' }).reviewLink, true);
  assert.equal(appointmentActionPlan({ ...RECEPTION, status: 'completed' }).reviewLink, true);
  assert.equal(appointmentActionPlan({ ...OTHER, status: 'completed' }).reviewLink, false, 'not someone else’s appointment');
  assert.equal(appointmentActionPlan({ canOperate: false, canModify: true, status: 'completed', ...STARTED }).reviewLink, false);
  for (const status of ['scheduled', 'confirmed', 'cancelled', 'no_show']) {
    assert.equal(appointmentActionPlan({ ...OWN, status }).reviewLink, false, `${status}: no review link`);
  }
  const card = read('web/components/scheduling/agenda/AppointmentCard.tsx');
  assert.ok(card.includes('{plan.reviewLink ? <ReviewSection'), 'desktop and phone show it from the plan (one card)');
  assert.ok(read('web/components/scheduling/AgendaView.tsx').includes('getReviewLinkAction(props.clientId, appt.id)'));
});

test('JP-4 «Cambiar servicio» is offered for scheduled/confirmed/completed, never cancelled/no_show', () => {
  for (const status of ['scheduled', 'confirmed', 'completed']) {
    assert.equal(appointmentActionPlan({ ...OWN, status }).changeService, true, `${status}: offered`);
  }
  for (const status of ['cancelled', 'no_show']) {
    assert.equal(appointmentActionPlan({ ...OWN, status }).changeService, false, `${status}: not offered`);
  }
  // Never for someone else's appointment, nor a login that can't operate the agenda.
  for (const status of ['scheduled', 'confirmed', 'completed']) {
    assert.equal(appointmentActionPlan({ ...OTHER, status }).changeService, false, `${status}: not for another column`);
  }
  assert.equal(appointmentActionPlan({ canOperate: false, canModify: true, status: 'scheduled', ...STARTED }).changeService, false);
});

test('JP-4 «Corregir hora o profesional» is offered for any status except cancelled (incl. past/completed)', () => {
  for (const status of ['scheduled', 'confirmed', 'completed', 'no_show']) {
    assert.equal(appointmentActionPlan({ ...OWN, status }).correctTime, true, `${status}: offered`);
  }
  assert.equal(appointmentActionPlan({ ...OWN, status: 'cancelled' }).correctTime, false, 'a cancelled appointment never happened');
  for (const status of ['scheduled', 'confirmed', 'completed']) {
    assert.equal(appointmentActionPlan({ ...OTHER, status }).correctTime, false, `${status}: not for another column`);
  }
  assert.equal(appointmentActionPlan({ canOperate: false, canModify: true, status: 'confirmed', ...STARTED }).correctTime, false);
});

test('JP-5 the in-card edit affordances come from the shared plan, not a separate rule', () => {
  const card = read('web/components/scheduling/agenda/AppointmentCard.tsx');
  // The card decides each field's mode (edit / guided / ask / none) from the plan flags + role.
  assert.ok(card.includes('plan.changeService') && card.includes('plan.correctTime'), 'the card reads both flags from the plan');
  assert.ok(!card.includes('appointmentActionPlan('), 'the card does not compute the plan itself');
  // Edit happens in place, on the row — one vocabulary from control to editor title.
  assert.ok(card.includes('Cambiar fecha y hora') && card.includes('Cambiar') , 'the time control uses the plain verb');
});

test('Completar waits for the start — the same answer on desktop and phone (finding A)', () => {
  const at = (deltaMin: number) => ({ canOperate: true, canModify: true, startAt: START, now: Date.parse(START) + deltaMin * 60_000 });
  // A FUTURE appointment: confirm / cancel / no-show yes, completed no, no "Completar" primary.
  const future = appointmentActionPlan({ ...at(-90), status: 'confirmed' });
  assert.deepEqual(future.transitions, ['no_show', 'cancelled']);
  assert.equal(future.complete, false);
  assert.equal(future.primary, null, 'the phone offers no "Completar" before the start');
  assert.equal(future.completeWaitsForStart, true);
  assert.equal(appointmentActionPlan({ ...at(-1 / 60_000), status: 'scheduled' }).transitions.includes('completed'), false, '1 ms before the start');
  // The EXACT start enables it; so does any time after.
  for (const d of [0, 1, 240]) {
    const p = appointmentActionPlan({ ...at(d), status: 'confirmed' });
    assert.ok(p.transitions.includes('completed'), `+${d} min`);
    assert.equal(p.primary, 'completed');
    assert.equal(p.completeWaitsForStart, false);
  }
  // Sin confirmar, future: Confirmar is still the primary.
  assert.equal(appointmentActionPlan({ ...at(-90), status: 'scheduled' }).primary, 'confirmed');
  // The server holds the same rule for every agenda caller.
  const action = read('web/lib/schedulingActions.ts');
  assert.match(action, /requireStartedToComplete: true/);
  const engine = read('src/scheduling/booking.ts');
  assert.match(engine, /target === 'completed' && input\.requireStartedToComplete && current\.start_at\.getTime\(\) > /);
  assert.ok(read('web/components/scheduling/agenda/AppointmentCard.tsx').includes('{plan.completeWaitsForStart ? <span className="c5-note ml-auto">Completar se habilita al empezar la cita</span>'), 'desktop and phone say why');
});
