import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  availabilityReducer,
  availabilityView,
  choiceStillOffered,
  compareReschedule,
  dayStatus,
  initialAvailability,
  rescheduleBlockedReason,
  staffFirstName,
  timesForDay,
  type AvailabilityModel,
  type RescheduleSlot,
} from '../../web/lib/rescheduleFlow.js';

/**
 * "Cambiar fecha y hora" — the pure rules of the reschedule flow. The bug in production:
 * the flow opened straight on the time step without ever asking for availability, said
 * "Sin cupos" for a search that never ran, and only asked when the month changed.
 */

const TZ = 'America/Bogota';
const FEDE = 'f0acd1aa-2a19-46f9-9ae6-ef01d36f896f';
const FALLA = '704658b6-8909-4421-ba44-3a4a9eef7d71';
const slot = (iso: string, staff = [FEDE], minutes = 50): RescheduleSlot => ({
  start_at: iso,
  service_end_at: new Date(new Date(iso).getTime() + minutes * 60_000).toISOString(),
  staff_id: staff[0],
  available_staff_ids: staff,
});
// 19 Oct 2026, Bogotá (UTC-5): 10:00, 11:15, 17:00; 20 Oct: 09:00.
const OCT = [slot('2026-10-19T15:00:00.000Z'), slot('2026-10-19T16:15:00.000Z'), slot('2026-10-19T22:00:00.000Z'), slot('2026-10-20T14:00:00.000Z')];
const open = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
const status = (m: AvailabilityModel, day: string, today = '2026-10-17') =>
  dayStatus({ day, today, openWeekdays: open, state: availabilityView(m), timeZone: TZ });

test('opening the flow ASKS at once — for the appointment\'s own professional and month', () => {
  const m = initialAvailability({ staffId: FEDE, month: '2026-10' });
  assert.equal(m.requested.id, 1, 'a request exists from the first render (no step to "advance" first)');
  assert.deepEqual(availabilityView(m), { kind: 'loading', staffId: FEDE, month: '2026-10' });
  assert.equal(status(m, '2026-10-19'), 'loading', 'while asking it is "buscando", never "sin cupos"');
});

test('changing day inside the loaded month needs no new request; every day answers', () => {
  const m = availabilityReducer(initialAvailability({ staffId: FEDE, month: '2026-10' }), { type: 'loaded', requestId: 1, slots: OCT });
  assert.equal(status(m, '2026-10-19'), 'available');
  assert.equal(status(m, '2026-10-20'), 'available');
  assert.equal(status(m, '2026-10-21'), 'none', 'searched and empty → "sin disponibilidad"');
  assert.equal(status(m, '2026-10-18'), 'closed', 'Sunday');
  assert.equal(status(m, '2026-10-16'), 'past');
  assert.deepEqual(timesForDay(availabilityView(m), '2026-10-19', TZ).map((s) => s.start_at.slice(11, 16)), ['15:00', '16:15', '22:00']);
});

test('changing month or professional asks again; an older answer can never land', () => {
  let m = availabilityReducer(initialAvailability({ staffId: FEDE, month: '2026-10' }), { type: 'request', staffId: FEDE, month: '2026-11' }); // id 2
  m = availabilityReducer(m, { type: 'request', staffId: FALLA, month: '2026-11' }); // id 3
  assert.equal(m.requested.id, 3);
  // The October answer (id 1) and the Federico/November one (id 2) arrive late: dropped.
  m = availabilityReducer(m, { type: 'loaded', requestId: 1, slots: OCT });
  m = availabilityReducer(m, { type: 'loaded', requestId: 2, slots: [slot('2026-11-02T15:00:00.000Z')] });
  assert.equal(availabilityView(m).kind, 'loading', 'still waiting for the CURRENT question');
  m = availabilityReducer(m, { type: 'loaded', requestId: 3, slots: [slot('2026-11-03T15:00:00.000Z', [FALLA])] });
  const v = availabilityView(m);
  assert.equal(v.kind, 'ready');
  assert.equal(v.staffId, FALLA);
  assert.deepEqual(timesForDay(v, '2026-11-02', TZ), [], 'Federico\'s late November slots never show for Falla');
  assert.equal(timesForDay(v, '2026-11-03', TZ).length, 1);
  assert.equal(status(m, '2026-10-20'), 'unknown', 'a month not asked is "sin consultar", not "sin cupos"');
});

test('a failed search is an ERROR with retry — never "no availability"', () => {
  let m = availabilityReducer(initialAvailability({ staffId: FEDE, month: '2026-10' }), { type: 'failed', requestId: 1 });
  assert.equal(availabilityView(m).kind, 'error');
  assert.equal(status(m, '2026-10-19'), 'error');
  // Reintentar = the same question again → loading, then the answer.
  m = availabilityReducer(m, { type: 'request', staffId: FEDE, month: '2026-10' });
  assert.equal(availabilityView(m).kind, 'loading');
  m = availabilityReducer(m, { type: 'failed', requestId: 1 }); // the old failure again: ignored
  assert.equal(availabilityView(m).kind, 'loading');
  m = availabilityReducer(m, { type: 'loaded', requestId: 2, slots: OCT });
  assert.equal(status(m, '2026-10-19'), 'available');
});

test('the chosen time is dropped as soon as its conditions change', () => {
  const ready = availabilityView(availabilityReducer(initialAvailability({ staffId: FEDE, month: '2026-10' }), { type: 'loaded', requestId: 1, slots: OCT }));
  const t = '2026-10-19T22:00:00.000Z';
  assert.equal(choiceStillOffered(ready, t, FEDE), true);
  assert.equal(choiceStillOffered(ready, t, FALLA), false, 'another professional');
  assert.equal(choiceStillOffered(ready, '2026-10-19T23:00:00.000Z', FEDE), false, 'no longer offered after a refresh');
  assert.equal(choiceStillOffered({ kind: 'loading', staffId: FEDE, month: '2026-10' }, t, FEDE), false, 'while re-asking');
});

test('before / after from REAL values; no effective change → nothing to confirm', () => {
  const appt = { start_at: '2026-10-17T16:00:00.000Z', service_end_at: '2026-10-17T16:50:00.000Z', staff_id: FEDE, staff_name: 'Federico Ruiz' };
  const moved = compareReschedule(appt, { start_at: '2026-10-17T22:00:00.000Z', service_end_at: '2026-10-17T22:50:00.000Z', staff_id: FEDE, staff_name: 'Federico Ruiz' }, TZ);
  assert.equal(moved.before.line, 'sábado 17, 11:00–11:50 · Federico');
  assert.equal(moved.after?.line, 'sábado 17, 17:00–17:50 · Federico');
  assert.equal(moved.hasChange, true);
  assert.equal(moved.staffChanged, false);

  const same = compareReschedule(appt, { ...appt }, TZ);
  assert.equal(same.hasChange, false, '"Confirmar cambio" stays disabled');

  const other = compareReschedule(appt, { ...appt, staff_id: FALLA, staff_name: 'Falla' }, TZ);
  assert.equal(other.staffChanged, true);
  assert.equal(other.hasChange, true, 'same time, another professional is a change');
  assert.equal(other.after?.line, 'sábado 17, 11:00–11:50 · Falla');

  const nextMonth = compareReschedule(appt, { ...appt, start_at: '2026-11-02T15:00:00.000Z', service_end_at: '2026-11-02T15:50:00.000Z' }, TZ);
  assert.equal(nextMonth.before.line, 'sábado 17 oct, 11:00–11:50 · Federico', 'the month is said when it changes');
  assert.equal(nextMonth.after?.line, 'lunes 2 nov, 10:00–10:50 · Federico');
});

test('the after time keeps the appointment\'s STORED duration (the slot the server offered)', () => {
  // A 40-min appointment of a service that now lasts 50: the endpoint returns 40-min slots.
  const appt = { start_at: '2026-10-19T20:00:00.000Z', service_end_at: '2026-10-19T20:40:00.000Z', staff_id: FEDE, staff_name: 'Federico' };
  const s = slot('2026-10-19T21:00:00.000Z', [FEDE], 40);
  const c = compareReschedule(appt, { start_at: s.start_at, service_end_at: s.service_end_at, staff_id: FEDE, staff_name: 'Federico' }, TZ);
  assert.equal(c.after?.time, '16:00–16:40');
});

test('why the action is not offered, in words', () => {
  assert.match(rescheduleBlockedReason({ status: 'cancelled', allowed: true, staffName: 'Federico' })!, /cancelada/);
  assert.match(rescheduleBlockedReason({ status: 'completed', allowed: true, staffName: 'Federico' })!, /completó/);
  assert.match(rescheduleBlockedReason({ status: 'no_show', allowed: true, staffName: 'Federico' })!, /inasistencia/);
  assert.match(rescheduleBlockedReason({ status: 'scheduled', allowed: false, staffName: '[Demo] Federico Ruiz' })!, /es de Federico/);
  assert.equal(rescheduleBlockedReason({ status: 'confirmed', allowed: true, staffName: 'Federico' }), null);
  assert.equal(staffFirstName('[Demo] Federico Ruiz'), 'Federico');
});

// ── Contracts on the components (what a refactor must not undo) ───────────────────

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

test('the flow asks FOR THIS appointment and the professional on screen, and sends the same', () => {
  const flow = read('web/components/scheduling/agenda/RescheduleFlow.tsx');
  assert.match(flow, /useReducer\(availabilityReducer, \{ staffId: appt\.staff_id, month: startDay\.slice\(0, 7\) \}, initialAvailability\)/, 'pre-selects its professional (never "Cualquiera") and asks at once');
  assert.match(flow, /staff_id: q\.staffId,\s+appointment_id: appt\.id/, 'availability excludes the appointment itself and uses its stored timing');
  assert.match(flow, /rescheduleAppointmentAction\(props\.clientId, appt\.id, slot\.start_at, staffId === appt\.staff_id \? null : staffId, \{/, 'the professional sent is the one on screen');
  assert.match(flow, /startAt: appt\.start_at,\s+staffId: appt\.staff_id/, 'the "Antes" values are sent for the optimistic check');
  assert.match(flow, /if \(!slot \|\| !comparison\.hasChange \|\| sending\.current\) return;/, 'no double submit, no empty change');
  assert.doesNotMatch(flow, /Cualquiera/);
  assert.match(flow, /Paso \{step\} de 2/, 'two steps, not the three of creation');
});

test('the detail offers «Reagendar» directly, with one name, apart from the state', () => {
  const panel = read('web/components/scheduling/agenda/AppointmentPanel.tsx');
  const card = read('web/components/scheduling/agenda/AppointmentCard.tsx');
  for (const [name, src] of [['panel', panel], ['card', card]] as const) {
    assert.match(src, /Reagendar/, name);
    assert.doesNotMatch(src, />\s*Reprogramar\s*</, `${name}: no "Reprogramar" entry`);
    assert.doesNotMatch(src, /Cambiar hora o profesional/, name);
  }
  assert.match(panel, /rescheduleBlockedReason\(/, 'says why when it is not offered');
  // The card's footer, beside the next step — apart from the state; the same on the phone.
  assert.ok(card.includes('plan.reschedule && props.onReschedule ? (') && card.includes('footNote'), 'Reagendar is the footer secondary, with the reason when blocked');
  assert.doesNotMatch(read('web/components/scheduling/mobile/MobileAppointmentSheet.tsx'), /Más acciones/, 'no "Más acciones" detour on the phone');
});
