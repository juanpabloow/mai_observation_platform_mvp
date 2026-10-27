import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apptWho, durationText, findOverlap, isReschedule, type EditableAppt } from '../../web/lib/appointmentEdit.js';

/**
 * JP-5 — the pure helpers behind the inline editors' live preview + conflict, and the one rule
 * that decides reschedule vs correction without asking the operator. The SERVER is still the
 * authority on save (editAppointment.test.ts covers it end to end); these pin the client math
 * that drives the preview, and that its overlap semantics match the engine's.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

const appt = (over: Partial<EditableAppt> & { id: string; start_at: string; service_end_at: string }): EditableAppt => ({
  staff_id: 'ana',
  staff_name: 'Ana',
  status: 'confirmed',
  service_name: 'Corte',
  contact_name: null,
  guest_name: null,
  ...over,
});

// Bogotá-ish ISO instants (the helper is tz-agnostic — it compares epoch ms).
const T = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 2, h, m)).toISOString();
const ms = (iso: string) => Date.parse(iso);

test('findOverlap: a clear slot has no conflict', () => {
  const others = [appt({ id: 'a', start_at: T(12), service_end_at: T(13) })];
  assert.equal(findOverlap(others, { staffId: 'ana', startMs: ms(T(10)), endMs: ms(T(11)), excludeId: 'self' }), null);
});

test('findOverlap: an overlapping appointment of the SAME professional is found; another professional is not', () => {
  const others = [
    appt({ id: 'a', staff_id: 'ana', start_at: T(10, 30), service_end_at: T(11, 30) }),
    appt({ id: 'b', staff_id: 'beto', start_at: T(10), service_end_at: T(11) }),
  ];
  // 10:00–11:00 for Ana overlaps a (10:30–11:30), not b (another column).
  const hit = findOverlap(others, { staffId: 'ana', startMs: ms(T(10)), endMs: ms(T(11)), excludeId: 'self' });
  assert.equal(hit?.id, 'a');
  assert.equal(findOverlap(others, { staffId: 'beto', startMs: ms(T(12)), endMs: ms(T(13)), excludeId: 'self' }), null);
});

test('findOverlap: the appointment being edited never conflicts with itself, and a cancelled one never blocks', () => {
  const others = [
    appt({ id: 'self', staff_id: 'ana', start_at: T(10), service_end_at: T(11) }),
    appt({ id: 'x', staff_id: 'ana', status: 'cancelled', start_at: T(10, 30), service_end_at: T(11, 30) }),
  ];
  assert.equal(findOverlap(others, { staffId: 'ana', startMs: ms(T(10)), endMs: ms(T(11)), excludeId: 'self' }), null, 'self + cancelled both ignored');
});

test('findOverlap: half-open intervals — back-to-back does NOT overlap', () => {
  const others = [appt({ id: 'a', staff_id: 'ana', start_at: T(11), service_end_at: T(12) })];
  assert.equal(findOverlap(others, { staffId: 'ana', startMs: ms(T(10)), endMs: ms(T(11)), excludeId: 'self' }), null, '10–11 then 11–12 touch but do not overlap');
  const hit = findOverlap(others, { staffId: 'ana', startMs: ms(T(10)), endMs: ms(T(11, 1)), excludeId: 'self' });
  assert.equal(hit?.id, 'a', 'one minute into the next appointment overlaps');
});

test('findOverlap mirrors the engine: both drop only cancelled from the overlap scan', () => {
  // The client helper excludes cancelled; the engine (appointments repo) filters status <> 'cancelled'.
  assert.match(read('web/lib/appointmentEdit.ts'), /status === "cancelled"/);
  assert.match(read('src/db/repositories/scheduling/appointments.ts'), /status\s*<>\s*'cancelled'/);
});

test('isReschedule picks reschedule for a FUTURE live appointment and correction otherwise', () => {
  const now = ms(T(12));
  assert.equal(isReschedule('confirmed', ms(T(15)), now), true, 'future confirmed → reschedule');
  assert.equal(isReschedule('scheduled', ms(T(15)), now), true, 'future scheduled → reschedule');
  assert.equal(isReschedule('confirmed', ms(T(9)), now), false, 'past → correction');
  assert.equal(isReschedule('completed', ms(T(15)), now), false, 'completed → correction, even if start is ahead');
  assert.equal(isReschedule('no_show', ms(T(15)), now), false, 'no_show → correction');
  assert.equal(isReschedule('cancelled', ms(T(15)), now), false);
});

test('durationText + apptWho read in plain words', () => {
  assert.equal(durationText(45), '45 min');
  assert.equal(durationText(60), '1 h');
  assert.equal(durationText(90), '1 h 30 min');
  assert.equal(apptWho(appt({ id: 'a', start_at: T(10), service_end_at: T(11), contact_name: 'Ana' })), 'Ana');
  assert.equal(apptWho(appt({ id: 'a', start_at: T(10), service_end_at: T(11), guest_name: 'Beto' })), 'Beto');
  assert.equal(apptWho(appt({ id: 'a', start_at: T(10), service_end_at: T(11) })), 'otra cita');
});

test('the card drives the inline editors from the shared helpers and the role/paid rules', () => {
  const card = read('web/components/scheduling/agenda/AppointmentCard.tsx');
  // reschedule vs correction is decided by the helper, never asked.
  assert.ok(card.includes('isReschedule('), 'the time editor picks its mode from isReschedule');
  // Each row edits in place — the editor opens under the row (editing state keyed by field).
  assert.ok(card.includes('setEditing({ kind: "time" })') && card.includes('setEditing({ kind: "service" })') && card.includes('setEditing({ kind: "staff" })'), 'each row opens its own editor');
  // Paid locks service + professional with the per-role copy; Staff gets no control.
  assert.ok(card.includes('Para cambiar el servicio, primero anula el cobro'), 'the paid lock states the rule');
  assert.ok(card.includes('Anular cobro y cambiar'), 'Owner gets the guided void → change');
  assert.ok(card.includes('Pídele al dueño que lo anule'), 'the Setter is told who can unlock it');
  assert.ok(card.includes('props.isStaffLogin') && card.includes('"none"'), 'a staff login gets no money-field control');
  // The guided flow ends by reopening the (prefilled) charge step.
  assert.ok(card.includes('props.payment?.onRecord()') && card.includes('"recharge"'), 'the guided flow ends at the charge step');
});

test('"Anular cobro" is a destructive secondary control that requires a reason', () => {
  const pay = read('web/components/scheduling/agenda/PaymentSection.tsx');
  assert.ok(pay.includes('Anular cobro') && !pay.includes('>Anular registro<'), 'renamed to the plain-money verb');
  assert.ok(pay.includes('quedará anulado y la cita volverá a cobro pendiente'), 'the consequence states the amount + outcome');
  // The confirm cannot be submitted without a reason.
  assert.ok(pay.includes('disabled={!voiding.reason.trim()'), 'the reason is required');
  const edit = read('web/components/scheduling/agenda/editPanels.tsx');
  assert.ok(edit.includes('disabled={!reason.trim() || pending}'), 'the guided void requires a reason too');
});
