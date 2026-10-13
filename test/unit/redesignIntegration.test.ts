import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('the integrated agenda passes only permission-filtered blocks, once', () => {
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.equal((page.match(/blocks=\{/g) ?? []).length, 1);
  assert.match(page, /const rawBlocks = exceptions/);
  assert.match(page, /filter\(\(b\) => !isStaff \|\| b.staff_id === null \|\| b.staff_id === myStaffId\)/);
  assert.match(page, /blocks=\{blocks\}/);
  assert.match(page, /canBlockStaff=\{canBlockStaff\}/);
  assert.match(page, /canBlockSite=\{canBlockSite\}/);
});

test('service creation keeps normalized descriptions AND transactional site links', () => {
  const actions = read('web/lib/schedulingAdminActions.ts');
  const create = actions.slice(actions.indexOf('export async function createServiceAction'), actions.indexOf('export async function updateServiceAction'));
  assert.match(create, /normalizeServiceDescription\(input.description\)/);
  assert.match(create, /createServiceWithSites\([\s\S]*?description: desc.value/);
  assert.match(create, /ServiceSiteLinkError/);
  assert.doesNotMatch(create, /await setSiteService\(/);
  for (const path of ['web/components/scheduling/services/ServiceEditor.tsx', 'web/components/scheduling/mobile/config/ServicesMobile.tsx']) {
    assert.match(read(path), /maxLength=\{SERVICE_DESCRIPTION_MAX\}/);
  }
  assert.match(read('web/components/scheduling/services/ServiceEditor.tsx'), /description.trim\(\).length > SERVICE_DESCRIPTION_MAX/);
});

test('week cards retain preview, two-card overflow AND kept-appointment block warnings', () => {
  const agenda = read('web/components/scheduling/AgendaView.tsx');
  const cards = agenda.slice(agenda.indexOf('{shown.map((appt)'), agenda.indexOf('{rest.length > 0', agenda.indexOf('{shown.map((appt)')));
  assert.match(cards, /conflict=\{conflictIds.has\(appt.id\)\}/);
  assert.match(cards, /previewProps=\{previewProps\(appt\)\}/);
  assert.match(cards, /onOpen=\{\(\) => openAppointment\(appt.id\)\}/);
  assert.match(agenda, /const \[lead, second, ...rest\] = block.appointments/);
  assert.match(agenda, /<BlockBand[\s\S]{0,650}mode: "editBlock"/);
});

test('phone views retain time-off entry points and past blocks remain read-only', () => {
  const agenda = read('web/components/scheduling/AgendaView.tsx');
  assert.match(agenda, /onBlock=\{props.canBlockStaff \|\| props.canBlockSite \?/);
  assert.match(read('web/components/scheduling/mobile/MobileAgenda.tsx'), /props.onBlock \? \([\s\S]{0,200}onClick=\{props.onBlock\}/);
  const team = read('web/components/scheduling/mobile/team/TeamMember.tsx');
  assert.match(team, /Date.parse\(t.endsAt\) > now/);
  assert.match(team, /<TimeOffForm[\s\S]{0,450}fixedStaffId=\{member.id\}/);
  assert.match(team, /deleteTimeOffAction\(clientId, timeOffDelete.id\)/);
  assert.match(read('web/app/clients/[clientId]/scheduling/staff/page.tsx'), /id: e.id, staffId: ""/);
});
