import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SYSTEM_ROLE_PERMISSIONS } from '../../web/lib/permissions/catalog.js';

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
  // Capabilities are permissions (catalog), scope is the membership: a professional login
  // is identified by its staff BINDING, never by its role's name.
  assert.match(access, /export function isSchedulingStaff[\s\S]{0,80}return scope\.schedulingStaffId !== null/);
  // Staff pinned to its one site.
  assert.match(access, /export function canAccessSchedulingSite[\s\S]*if \(isSchedulingStaff\(scope\)\) return scope\.schedulingSiteId === siteId/);
  // Staff writes only its own column.
  assert.match(access, /export function canAccessSchedulingStaff[\s\S]*if \(isSchedulingStaff\(scope\)\) return scope\.schedulingStaffId === staffId/);
  // THE capability predicate: in scope AND holding the permission.
  assert.match(access, /export function can\(scope: AccessScope, key: PermissionKey, clientId: string\): boolean \{\s*return inClientScope\(scope, clientId\) && scope\.permissions\.has\(key\);/);
  assert.match(access, /export function isClientOwner[\s\S]*scope\.clientRole === "owner" && scope\.memberClientId === clientId/);
  // Fail closed: a member MUST carry a valid client role (system or a resolvable custom one).
  assert.match(access, /return \{ ok: false \}; \/\/ unknown \/ absent client role → deny/);
  // The Profesional role is the agenda only — what a staff login could do before.
  assert.deepEqual([...SYSTEM_ROLE_PERMISSIONS.staff].sort(), ['agenda.book', 'agenda.view']);
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

  // Writes need agenda.book (reads agenda.view) through the module gate.
  assert.match(actions, /gateClientModule\(clientId, "scheduling", permission, GENERIC_GATE\)/);
  // Settings need the screen's own permission (Recepción/Profesional hold none of them).
  const admin = read('web/lib/schedulingAdminActions.ts');
  assert.match(admin, /resolveClientModuleContext\(clientId, "scheduling", permission\)/);
  assert.doesNotMatch(admin, /requireSchedulingAdmin\((input\.)?clientId\);/, 'every admin action names its permission');
  assert.doesNotMatch(admin, /requireFullAccessForAction/);
  // Custom-field definitions likewise.
  const fields = read('web/lib/fieldDefinitionActions.ts');
  assert.match(fields, /resolveClientModuleContext\(clientId, "crm", "contacts\.fields"\)/);
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

  // The rail reads permissions + the staff binding (lib/sectionNav.ts), never role names.
  const sidebar = read('web/components/AppSidebar.tsx');
  const model = read('web/lib/sectionNav.ts');
  assert.match(model, /if \(staffBound\) \{/);
  assert.match(model, /const p = \(key: string\) => forOwnClient && permissions\.includes\(key\)/);
  assert.match(sidebar, /if \(staffBound\) \{/);
  assert.doesNotMatch(sidebar + model, /schedulingAccess/);
  assert.doesNotMatch(model, /clientRole/);
});
