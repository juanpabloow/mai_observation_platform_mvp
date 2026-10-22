import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  AGENCY_PERMISSIONS,
  ALL_PERMISSION_KEYS,
  BUSINESS_GRANTABLE_KEYS,
  PERMISSIONS,
  PERMISSION_AREAS,
  SYSTEM_ROLE_PERMISSIONS,
  missingRequirements,
  sanitizeBusinessPermissions,
  type PermissionKey,
} from '../../web/lib/permissions/catalog.js';
import {
  canCreateRole,
  canEditRole,
  canEditSystemRole,
  permissionsOfRole,
  canGrantRole,
  canManageMember,
  diffPermissions,
  grantableBy,
  roleRefOf,
  validateRolePermissions,
  type DelegationActor,
} from '../../web/lib/permissions/delegation.js';
import { areaState, setArea, togglePermission } from '../../web/lib/permissions/editorModel.js';

/**
 * Roles v1 — the PURE core: the permission catalog, the system-role translation, the
 * delegation rules and the role editor's dependency logic. The same functions decide on
 * the server (actions) and in the UI (which controls to show), so they are tested here
 * once; test/integration/accessRoles.test.ts drives them through the real actions + DB.
 */

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const set = (...k: PermissionKey[]) => new Set<PermissionKey>(k);

const agency: DelegationActor = { userId: 'agency', memberClientId: null, clientRole: null, accessRoleId: null, permissions: AGENCY_PERMISSIONS };
const owner: DelegationActor = { userId: 'owner', memberClientId: A, clientRole: 'owner', accessRoleId: null, permissions: SYSTEM_ROLE_PERMISSIONS.owner };
const setter: DelegationActor = { userId: 'setter', memberClientId: A, clientRole: 'setter', accessRoleId: null, permissions: SYSTEM_ROLE_PERMISSIONS.setter };
const coord = (perms: PermissionKey[], roleId = 'role-coord'): DelegationActor => ({
  userId: 'coord', memberClientId: A, clientRole: 'custom', accessRoleId: roleId, permissions: new Set(perms),
});

test('catalog: stable unique keys, real areas, closed dependencies, nothing platform-level', () => {
  assert.equal(new Set(ALL_PERMISSION_KEYS).size, ALL_PERMISSION_KEYS.length, 'keys are unique');
  for (const p of PERMISSIONS) {
    assert.match(p.key, /^[a-z_]+(\.[a-z_]+)+$/, `${p.key} is area.action shaped (the DB CHECK)`);
    assert.ok(PERMISSION_AREAS.some((a) => a.id === p.area), `${p.key} sits in a known area`);
    for (const r of p.requires) assert.ok(ALL_PERMISSION_KEYS.includes(r as PermissionKey), `${p.key} requires a real key`);
    assert.ok(p.label && p.help, `${p.key} explains itself`);
  }
  // Importing / validating external reviews is a PLATFORM operation — never a checkbox.
  assert.ok(!ALL_PERMISSION_KEYS.some((k) => /import|platform|provenance/.test(k)), 'no platform capability in the catalog');
  // Every system role is dependency-closed.
  for (const [k, perms] of Object.entries(SYSTEM_ROLE_PERMISSIONS)) {
    assert.deepEqual(missingRequirements(perms), [], `${k} is dependency-closed`);
  }
});

test('system roles translate the previous behaviour exactly (no permission added by convenience)', () => {
  const o = SYSTEM_ROLE_PERMISSIONS.owner;
  // Dueño: everything of the business EXCEPT what only the agency did.
  for (const k of ['inbox.supervise', 'contacts.delete', 'meetings.manage'] as const) assert.ok(!o.has(k), `Dueño never had ${k}`);
  for (const k of ['analytics.view', 'analytics.assumptions.confirm', 'team.manage', 'access.users.manage', 'contacts.tags', 'contacts.export'] as const) {
    assert.ok(o.has(k), `Dueño keeps ${k}`);
  }
  // Recepción: the canAccessClient audience.
  assert.deepEqual([...SYSTEM_ROLE_PERMISSIONS.setter].sort(), [
    'agenda.block', 'agenda.book', 'agenda.view', 'campaigns.view', 'contacts.edit', 'contacts.export', 'contacts.view',
    'inbox.reply', 'inbox.view', 'pipeline.edit', 'pipeline.view', 'products.stock', 'products.view',
  ]);
  // Profesional: the agenda only.
  assert.deepEqual([...SYSTEM_ROLE_PERMISSIONS.staff].sort(), ['agenda.book', 'agenda.view']);
  // Agency: everything but the business-only confirmation.
  assert.ok(!AGENCY_PERMISSIONS.has('analytics.assumptions.confirm'));
  assert.equal(AGENCY_PERMISSIONS.size, ALL_PERMISSION_KEYS.length - 1);
});

test('deny by default: unknown, retired and agency-only keys stored in the DB are ignored', () => {
  const got = sanitizeBusinessPermissions(['contacts.view', 'contacts.teleport', 'meetings.manage', 42, null]);
  assert.deepEqual([...got], ['contacts.view']);
  assert.ok(!BUSINESS_GRANTABLE_KEYS.includes('meetings.manage'));
});

test('role permission validation: known, grantable, dependency-closed', () => {
  assert.equal(validateRolePermissions(['contacts.edit']).ok, false, 'editing needs seeing');
  assert.deepEqual(validateRolePermissions(['contacts.edit', 'contacts.view']), { ok: true, keys: ['contacts.edit', 'contacts.view'] });
  assert.equal(validateRolePermissions(['meetings.manage', 'meetings.view']).ok, false, 'agency-only key refused');
  assert.equal(validateRolePermissions(['bogus.key']).ok, false);
  assert.deepEqual(validateRolePermissions([]), { ok: true, keys: [] }, 'an empty role is valid (it opens nothing)');
});

test('renaming a role never changes what it can do (permissions are the only input)', () => {
  const perms = set('contacts.view', 'contacts.edit');
  const a = roleRefOf({ client_role: 'custom', access_role_id: 'r1', role_permissions: [...perms] });
  const b = roleRefOf({ client_role: 'custom', access_role_id: 'r1', role_permissions: [...perms] });
  assert.deepEqual(a, b, 'no name in the role reference at all');
  // A custom role called «Dueño» is still just its permissions (and the name is refused at save).
  assert.equal(canGrantRole(owner, A, a!).ok, true);
});

test('delegation: nobody hands out more than they hold', () => {
  // The Dueño may create a role inside its own set, never with agency-only keys.
  assert.equal(canCreateRole(owner, A, ['contacts.view', 'contacts.edit']).ok, true);
  assert.equal(canCreateRole(owner, A, ['contacts.delete', 'contacts.edit', 'contacts.view']).ok, false, 'Dueño cannot grant contacts.delete');
  // A coordination role with roles.manage but no export cannot put export in a role.
  const c = coord(['access.users.view', 'access.roles.manage', 'contacts.view', 'contacts.edit']);
  assert.equal(canCreateRole(c, A, ['contacts.view']).ok, true);
  assert.equal(canCreateRole(c, A, ['contacts.view', 'contacts.export']).ok, false);
  // Recepción manages no roles at all.
  assert.equal(canCreateRole(setter, A, []).ok, false);
  // The agency can't hand out the business-only confirmation.
  assert.equal(canCreateRole(agency, A, ['analytics.view', 'analytics.assumptions.confirm']).ok, false);
  assert.ok(!grantableBy(agency, A).has('analytics.assumptions.confirm'));
});

test('delegation: no self-escalation, no editing your own role, no reaching other businesses', () => {
  const c = coord(['access.users.view', 'access.roles.manage', 'access.users.manage', 'contacts.view'], 'role-coord');
  assert.equal(canEditRole(c, A, 'role-coord', c.permissions, [...c.permissions, 'contacts.edit']).ok, false, 'own role is off-limits');
  assert.equal(canEditRole(c, A, 'role-coord', c.permissions, ['contacts.view']).ok, false, 'not even to narrow it');
  assert.equal(canManageMember(c, A, { userId: 'coord', role: { kind: 'custom', id: 'role-coord', permissions: c.permissions } }).ok, false, 'never yourself');
  // Another business: refused whatever the permissions.
  assert.equal(canCreateRole(owner, B, []).ok, false);
  assert.equal(canGrantRole(owner, B, { kind: 'system', key: 'setter' }).ok, false);
  // A role wider than the actor can't be edited, deleted or touched through its holders.
  const wide = set('contacts.view', 'contacts.edit', 'contacts.export');
  assert.equal(canEditRole(c, A, 'other', wide, ['contacts.view']).ok, false);
  assert.equal(canManageMember(c, A, { userId: 'x', role: { kind: 'custom', id: 'other', permissions: wide } }).ok, false);
});

test('delegation: the Dueño tier belongs to the agency', () => {
  assert.equal(canGrantRole(owner, A, { kind: 'system', key: 'owner' }).ok, false, 'a Dueño never mints a Dueño');
  assert.equal(canGrantRole(agency, A, { kind: 'system', key: 'owner' }).ok, true);
  assert.equal(canManageMember(owner, A, { userId: 'o2', role: { kind: 'system', key: 'owner' } }).ok, false, 'nor touches another Dueño');
  assert.equal(canManageMember(agency, A, { userId: 'o2', role: { kind: 'system', key: 'owner' } }).ok, true);
  // A near-Dueño custom role still never reaches the Dueño tier.
  const near = coord([...SYSTEM_ROLE_PERMISSIONS.owner]);
  assert.equal(canGrantRole(near, A, { kind: 'system', key: 'owner' }).ok, false);
  assert.equal(canManageMember(near, A, { userId: 'owner', role: { kind: 'system', key: 'owner' } }).ok, false);
  // The Dueño assigns Recepción / Profesional (both inside its set).
  assert.equal(canGrantRole(owner, A, { kind: 'system', key: 'setter' }).ok, true);
  assert.equal(canGrantRole(owner, A, { kind: 'system', key: 'staff' }).ok, true);
});

test('diffPermissions: what a change adds and removes (audit + confirmation summary)', () => {
  assert.deepEqual(diffPermissions(['contacts.view', 'inbox.view'], ['contacts.view', 'contacts.export']), {
    added: ['contacts.export'],
    removed: ['inbox.view'],
  });
});

test('editor: checking pulls requirements, unchecking drops dependents, groups go partial', () => {
  const g = new Set(BUSINESS_GRANTABLE_KEYS);
  let r = togglePermission(set(), 'pipeline.edit', g);
  assert.deepEqual([...r.next].sort(), ['contacts.view', 'pipeline.edit', 'pipeline.view']);
  assert.deepEqual(r.alsoAdded.sort(), ['contacts.view', 'pipeline.view']);
  r = togglePermission(r.next, 'contacts.view', g);
  assert.deepEqual([...r.next], [], 'removing contacts.view removes everything built on it');
  assert.deepEqual(r.alsoRemoved.sort(), ['pipeline.edit', 'pipeline.view']);
  // A requirement the viewer can't grant makes the key unavailable.
  const narrow = set('contacts.edit');
  assert.deepEqual([...togglePermission(set(), 'contacts.edit', narrow).next], []);
  // Group checkbox.
  assert.equal(areaState('inbox', set('inbox.view'), g), 'some');
  const all = setArea(set(), 'inbox', true, g).next;
  assert.equal(areaState('inbox', all, g), 'all');
  assert.equal(areaState('inbox', setArea(all, 'inbox', false, g).next, g), 'none');
});

test('system roles adjusted for ONE business: the agency only; the override is what counts', () => {
  // Only the agency adjusts a protected role — never the Dueño, whatever it holds.
  assert.equal(canEditSystemRole(agency, A, ['inbox.view']).ok, true);
  assert.equal(canEditSystemRole(owner, A, ['inbox.view']).ok, false, 'a Dueño edits custom roles, not the protected ones');
  assert.equal(canEditSystemRole(agency, A, ['meetings.view', 'meetings.manage']).ok, false, 'never an agency-only key');
  // A system role carries this business's override when there is one, else the default.
  const adjusted = roleRefOf({ client_role: 'setter', system_override: ['inbox.view', 'inbox.reply', 'meetings.manage'] })!;
  assert.deepEqual([...permissionsOfRole(adjusted)].sort(), ['inbox.reply', 'inbox.view'], 'agency-only keys dropped');
  assert.deepEqual(permissionsOfRole(roleRefOf({ client_role: 'setter', system_override: null })!), SYSTEM_ROLE_PERMISSIONS.setter);
  // Delegation reads the adjusted set: a Dueño can't give a Recepción the agency widened past it.
  const widened = roleRefOf({ client_role: 'setter', system_override: [...SYSTEM_ROLE_PERMISSIONS.setter, 'contacts.delete'] })!;
  assert.equal(canGrantRole(owner, A, widened).ok, false);
  assert.equal(canGrantRole(agency, A, widened).ok, true);
});
