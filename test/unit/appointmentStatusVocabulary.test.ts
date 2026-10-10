import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { APPOINTMENT_STATUS_LABELS, appointmentStatusLabel } from '../../web/lib/contactLabels.js';
import { STATUS_NAME } from '../../web/components/scheduling/agenda/status.js';
import { timelineCopy } from '../../web/lib/timelineCopy.js';

/**
 * AUDIT V6/D3 — the contact's appointment card said "Agendada" for the state the agenda
 * calls "Sin confirmar" (and "No asistió" for "Inasistencia"). A cita shows ONE
 * vocabulary everywhere: the agenda's. No state is added or renamed.
 */

test('the ficha prints the agenda\'s word for every appointment state', () => {
  assert.equal(appointmentStatusLabel('scheduled'), 'Sin confirmar');
  assert.equal(appointmentStatusLabel('confirmed'), 'Confirmada');
  assert.equal(appointmentStatusLabel('completed'), 'Completada');
  assert.equal(appointmentStatusLabel('cancelled'), 'Cancelada');
  assert.equal(appointmentStatusLabel('no_show'), 'Inasistencia');
});

test('the two maps cover the same states with the same words — no invented state', () => {
  assert.deepEqual(Object.keys(APPOINTMENT_STATUS_LABELS).sort(), Object.keys(STATUS_NAME).sort());
  for (const [state, label] of Object.entries(APPOINTMENT_STATUS_LABELS)) {
    assert.equal(label, STATUS_NAME[state], state);
  }
  assert.ok(!Object.values(APPOINTMENT_STATUS_LABELS).includes('Agendada'));
});

test('timeline EVENT titles are a different thing and stay', () => {
  // "what happened", not "what state it is in".
  assert.equal(timelineCopy('appointment_created').title, 'Cita agendada');
  assert.equal(timelineCopy('appointment_no_show').title, 'No asistió');
});
