import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * SOURCE CONTRACT for CLIENT-LEVEL ROLES (owner / editor / staff). This replaces the
 * retired scheduling_access (staff | reception) model: reception collapsed into editor,
 * staff gained own-column booking, and the whole thing is now one authoritative
 * `client_role` column. These assertions pin the SERVER-SIDE shape so a later edit can't
 * quietly weaken it.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

test('client roles: the migration adds client_role, keeps the staff binding + FKs', () => {
  const migration = read('migrations/1790000000000_client-roles.ts');
  assert.match(migration, /ADD COLUMN client_role text/);
  // owner/editor carry no binding; only staff does.
  assert.match(migration, /client_role IN \('owner','editor'\) AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL/);
  assert.match(migration, /client_role = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL/);
  // reception + standard both collapse to editor; only staff keeps its binding.
  assert.match(migration, /WHEN 'staff' THEN 'staff' ELSE 'editor'/);
  assert.match(migration, /DROP COLUMN scheduling_access/);

  // Invitations snapshot + grant the client role (so accepting is one atomic grant).
  const invitations = read('src/db/repositories/invitations.ts');
  assert.match(invitations, /grant\.client_role/);
  assert.match(invitations, /grant\.scheduling_site_id/);
  assert.match(invitations, /grant\.scheduling_staff_id/);
  assert.doesNotMatch(invitations, /scheduling_access/);
});

test('access.ts: the deny-by-default predicates encode the role matrix', () => {
  const access = read('web/lib/access.ts');
  // A STAFF login is not a general client login (no CRM/inbox/analytics).
  assert.match(access, /export function canAccessClient[\s\S]*if \(scope\.clientRole === "staff"\) return false/);
  // Owner/editor + agency may operate the agenda; staff too (constrained below).
  assert.match(access, /export function canOperateScheduling[\s\S]*scope\.clientRole !== null/);
  // Staff pinned to its one site.
  assert.match(access, /export function canAccessSchedulingSite[\s\S]*if \(scope\.clientRole === "staff"\) return scope\.schedulingSiteId === siteId/);
  // Staff writes only its own column.
  assert.match(access, /export function canAccessSchedulingStaff[\s\S]*if \(scope\.clientRole === "staff"\) return scope\.schedulingStaffId === staffId/);
  // Client-admin capability = agency OR this client's owner (settings/fields/team).
  assert.match(access, /export function canManageClient[\s\S]*hasFullAccess\(scope\) \|\| isClientOwner\(scope, clientId\)/);
  assert.match(access, /export function isClientOwner[\s\S]*scope\.clientRole === "owner" && scope\.memberClientId === clientId/);
  // Fail closed: a member MUST carry a valid client role.
  assert.match(access, /clientRole !== "owner" && clientRole !== "setter" && clientRole !== "staff"\) return \{ ok: false \}/);
});

test('scheduling actions: staff book their OWN column only; every write re-checks it', () => {
  const actions = read('web/lib/schedulingActions.ts');
  // The appointment gate refuses another staff member's appointment.
  assert.match(actions, /canAccessSchedulingStaff\(ctx\.scope, appointment\.staff_id\)/);
  // Create pins a staff login to its own column (and refuses an explicit other).
  assert.match(actions, /staffId = ctx\.scope\.schedulingStaffId/);
  assert.match(actions, /if \(staffId && !canAccessSchedulingStaff\(ctx\.scope, staffId\)\) return \{ ok: false, error: GENERIC_GATE \}/);
  // Reschedule can't move to another column.
  assert.match(actions, /isSchedulingStaff\(ctx\.scope\) && staffId && !canAccessSchedulingStaff\(ctx\.scope, staffId\)/);

  // Settings are agency OR this client's owner (editors/staff refused).
  const admin = read('web/lib/schedulingAdminActions.ts');
  assert.match(admin, /!canManageClient\(res\.context\.scope, clientId\)/);
  assert.doesNotMatch(admin, /requireFullAccessForAction/);
  // Custom-field definitions likewise.
  const fields = read('web/lib/fieldDefinitionActions.ts');
  assert.match(fields, /!canManageClient\(resolved\.context\.scope, clientId\)/);
});

test('the agenda page: staff see the whole SITE, identities hidden, no CRM/inbox links', () => {
  const page = read('web/app/clients/[clientId]/scheduling/agenda/page.tsx');
  // No longer narrowed to the staff's own column — they see every lane at their site.
  assert.doesNotMatch(page, /filter\(\(s\) => s\.id === scope\.schedulingStaffId\)/);
  // Identities are still withheld from staff, and drawer CRM/inbox links are staff-off.
  assert.match(page, /primary_identity: isSchedulingStaff\(scope\) \? null/);
  assert.match(page, /isSchedulingStaff\(scope\) \? Promise\.resolve\(false\) : isClientModuleEnabled/);
  // The booking modal pins a staff login to its own column.
  assert.match(page, /lockStaffId=\{isSchedulingStaff\(scope\) \? scope\.schedulingStaffId : null\}/);
});

test('team UI + sidebar speak client roles (owner/setter/staff)', () => {
  const invite = read('web/components/InviteForm.tsx');
  assert.match(invite, /<option value="setter">Setter/);
  assert.doesNotMatch(invite, /value="editor"/);
  assert.match(invite, /<option value="staff">Staff/);
  assert.match(invite, /canInviteOwner \? <option value="owner">Owner/);
  assert.match(invite, /clientRole: role/);
  assert.doesNotMatch(invite, /reception/i);

  const members = read('web/components/TeamMembers.tsx');
  assert.match(members, /changeClientRoleAction/);
  assert.match(members, /Save role/);
  assert.doesNotMatch(members, /setMemberSchedulingAccessAction/);

  const sidebar = read('web/components/AppSidebar.tsx');
  assert.match(sidebar, /clientRole === "staff"/);
  assert.match(sidebar, /canManageThisClient/);
  assert.match(sidebar, /canSeeGeneral/);
  assert.doesNotMatch(sidebar, /schedulingAccess/);
});
