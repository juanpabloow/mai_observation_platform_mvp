import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apptClientLabel } from '../../web/lib/apptClientLabel.ts';

// Audit 23 Oct: an ONLINE booking with no linked contact was titled «Atención sin cita».
test('the client label keeps name, CRM link and origin apart', () => {
  assert.equal(apptClientLabel({ contact_id: 'c1', contact_name: 'Ana Pérez', origin: 'public' }), 'Ana Pérez');
  assert.equal(apptClientLabel({ contact_id: 'c1', contact_name: null, origin: 'public' }), 'Sin nombre', 'linked contact without a name');
  assert.equal(apptClientLabel({ contact_id: null, contact_name: null, guest_name: 'Luis', origin: 'walk_in' }), 'Luis', 'a walk-in saved without a contact');
  assert.equal(apptClientLabel({ contact_id: null, contact_name: null, guest_name: null, origin: 'walk_in' }), 'Atención sin cita', 'only a walk-in is «sin cita»');
  assert.equal(apptClientLabel({ contact_id: null, contact_name: null, guest_name: null, origin: 'public' }), 'Sin contacto', 'an online booking without a contact');
  assert.equal(apptClientLabel({ contact_id: null, contact_name: '  ', origin: 'agent' }), 'Sin contacto');
});

test('every agenda surface names the client through the one rule', () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');
  for (const f of ['components/scheduling/mobile/MobileAppointmentSheet.tsx', 'components/scheduling/mobile/MobileAgenda.tsx', 'components/scheduling/agenda/AppointmentPanel.tsx', 'components/scheduling/agenda/AppointmentPreview.tsx', 'components/scheduling/agenda/RescheduleFlow.tsx', 'components/scheduling/AgendaView.tsx']) {
    const src = read(f);
    assert.ok(src.includes('apptClientLabel('), f);
    assert.ok(!/contact_name \?\? "Atención sin cita"/.test(src), `${f}: no «sin cita» just because there is no contact`);
  }
});
