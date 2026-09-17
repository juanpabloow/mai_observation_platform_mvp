import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('scheduling profiles are generic, client/site/staff constrained, and invitation-safe', () => {
  const migration = read('migrations/1784400000000_scheduling-member-access.ts');
  assert.match(migration, /scheduling_access = 'staff'/);
  assert.match(migration, /scheduling_access = 'reception'/);
  assert.match(migration, /FOREIGN KEY \(scheduling_site_id, tenant_id, member_client_id\)/);
  assert.match(migration, /FOREIGN KEY \(scheduling_staff_id, tenant_id, scheduling_site_id\)/);
  assert.match(migration, /tenant_members_one_login_per_staff/);
  assert.match(migration, /invitations_one_pending_per_staff/);
  assert.match(migration, /ALTER TABLE invitations/);

  const invitations = read('src/db/repositories/invitations.ts');
  assert.match(invitations, /grant\.scheduling_access/);
  assert.match(invitations, /grant\.scheduling_site_id/);
  assert.match(invitations, /grant\.scheduling_staff_id/);
});

test('staff access is read-only, one-site/one-resource, and not a general client login', () => {
  const access = read('web/lib/access.ts');
  assert.match(access, /scope\.schedulingAccess === "staff"/);
  assert.match(access, /if \(scope\.schedulingAccess\) return false/);
  assert.match(access, /scope\.schedulingSiteId === siteId/);
  assert.match(access, /scope\.schedulingStaffId === staffId/);

  const actions = read('web/lib/schedulingActions.ts');
  assert.match(actions, /!canOperateScheduling\(resolved\.context\.scope\)/);
  assert.match(actions, /canAccessSchedulingSite\(ctx\.scope, input\.siteId\)/);
  assert.match(actions, /gateAppointment\(clientId, appointmentId\)/);

  const availability = read('web/app/api/scheduling/internal/availability/route.ts');
  assert.match(availability, /!canOperateScheduling\(scope\)/);
  assert.match(availability, /!canAccessSchedulingSite\(scope, siteId\)/);
});

test('the agenda narrows reads server-side and exposes dedicated phone, tablet, and desktop layouts', () => {
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  assert.match(page, /staffId: isSchedulingStaff\(scope\)/);
  assert.match(page, /permittedStaff\.filter\(\(s\) => s\.id === scope\.schedulingStaffId\)/);
  assert.match(page, /primary_identity: isSchedulingStaff\(scope\) \? null/);
  assert.match(page, /canOperate=\{canOperateScheduling\(scope\)\}/);

  const view = read('web/components/scheduling/AgendaView.tsx');
  assert.match(view, /md:hidden/);
  assert.match(view, /mobileRows/);
  assert.match(view, /hidden min-h-0 flex-1 overflow-y-auto bg-canvas p-4 md:block xl:hidden/);
  assert.match(view, /hidden min-h-0 flex-1 overflow-auto xl:block/);
  assert.match(view, /function MobileAppointmentCard/);
  assert.match(view, /toneClass=\{appointmentToneClass\(appt, staffTones\)\}/);
  assert.match(view, /new Map<string, StaffTone>/);
  assert.match(view, /grid grid-cols-2 gap-2\.5 p-3/);
  assert.doesNotMatch(view, /border-(amber|emerald|sky)-/);
  assert.match(view, /modal && props\.canOperate/);
  assert.match(view, /live && canOperate/);
});

test('owners can assign staff/reception at invite time or update an existing member', () => {
  const invite = read('web/components/InviteForm.tsx');
  assert.match(invite, /Staff · own schedule/);
  assert.match(invite, /Reception · site agenda/);
  assert.match(invite, /schedulingStaffId/);

  const members = read('web/components/TeamMembers.tsx');
  assert.match(members, /setMemberSchedulingAccessAction/);
  assert.match(members, /Save access/);

  const sidebar = read('web/components/AppSidebar.tsx');
  assert.match(sidebar, /schedulingAccess === "staff" \? "My schedule" : "Agenda"/);
  assert.match(sidebar, /if \(isMember && schedulingAccess\)/);
});
