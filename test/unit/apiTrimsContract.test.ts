import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** SOURCE CONTRACT for the E-4 SAFE trims (additive; no removals). */
const web = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../web/${rel}`, import.meta.url)), 'utf8');

test('staff_name on every appointment object (projection + all single routes)', () => {
  const api = web('lib/schedulingApi.ts');
  assert.ok(api.includes('staff_name: staffName'), 'projectAppointment includes staff_name');
  assert.ok(api.includes('export async function projectSingleAppointment'), 'single-appointment projector exists (one staff lookup)');
  for (const t of ['cancel', 'confirm', 'complete', 'no-show', 'reschedule']) {
    assert.ok(web(`app/api/scheduling/v1/appointments/[id]/${t}/route.ts`).includes('projectSingleAppointment('), `${t} uses projectSingleAppointment`);
  }
  const list = web('app/api/scheduling/v1/appointments/route.ts');
  assert.ok(list.includes('projectSingleAppointment(auth.auth, result.value'), 'create uses projectSingleAppointment');
  assert.ok(list.includes('r.staff_name'), 'list passes the row staff_name (no per-row lookup)');
});

test('appointments list compact=true has the documented fields + is allowlisted', () => {
  const src = web('app/api/scheduling/v1/appointments/route.ts');
  assert.ok(/"compact"/.test(src), 'compact is in ALLOWED_PARAMS');
  assert.ok(src.includes('p.get("compact") === "true"'), 'reads compact');
  for (const f of ['id:', 'status:', 'service_name:', 'staff_name:', 'day:', 'date_label:', 'start_label:', 'end_label:', 'time:', 'contact:']) {
    assert.ok(src.includes(f), `compact row has ${f}`);
  }
});

test('price_label on services (additive; raw price kept)', () => {
  const src = web('app/api/scheduling/v1/services/route.ts');
  assert.ok(src.includes('price: s.effective_price') && src.includes('price_label: priceLabelCOP('), 'raw price kept + price_label added');
});

test('compact CRM contact drops the listed fields, keeps labels', () => {
  const api = web('lib/crmApi.ts');
  assert.ok(api.includes('export function toCompactContact'), 'toCompactContact exists');
  // The compact type must NOT carry the dropped fields.
  const compactType = api.slice(api.indexOf('export interface CompactContact'), api.indexOf('export function toCompactContact'));
  assert.ok(!/owner_user_id/.test(compactType), 'drops owner_user_id');
  assert.ok(!/public_reference/.test(compactType), 'drops next_appointment.public_reference');
  assert.ok(!/created_at_local|created_at:/.test(compactType), 'drops raw created_at pair');
  assert.ok(/start_label/.test(compactType) && /created_at_label/.test(compactType), 'keeps the spoken labels');
  for (const rel of ['app/api/crm/v1/contacts/[contactId]/route.ts', 'app/api/crm/v1/contacts/lookup/route.ts']) {
    assert.ok(web(rel).includes('toCompactContact(contact)') && web(rel).includes('compact'), `${rel} applies compact`);
  }
});
