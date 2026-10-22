import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { setMemberClientRole, getMembershipForUser } from '../../src/db/repositories/tenantMembers.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, type Scenario } from './fixtures.js';

/**
 * ROLES Y PERMISOS v1 — through the REAL server actions, repositories and PostgreSQL
 * (synthetic tenants only). The only stubs are the session read, Next's request
 * boundaries and the e-mail sender (no invitation ever leaves).
 *
 * Covers: system roles unchanged after the migration; custom roles made of permissions
 * (renaming changes nothing); direct action / API calls without the permission; tenant,
 * business and site isolation; the professional login; a module not contracted; self-
 * escalation and delegation; the last Dueño; the review importer out of reach; revocation
 * with the session open; deleting an assigned role; the audit trail.
 */

let CURRENT: string | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT, email: `${CURRENT.slice(0, 8)}@test.local` }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('refused: redirect()'); },
    notFound: () => { throw new Error('refused: notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers({ host: 'localhost:3999' }), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
mock.module(urlOf('server-only'), { namedExports: {} });
mock.module('../../web/lib/email.ts', {
  namedExports: { isEmailConfigured: false, sendEmail: async () => ({ ok: false, error: 'disabled in tests' }) },
});

const roles = await import('../../web/lib/roleActions.js');
const members = await import('../../web/lib/memberActions.js');
const invites = await import('../../web/lib/inviteActions.js');
const crm = await import('../../web/lib/crmActions.js');
const contacts = await import('../../web/lib/contactActions.js');
const catalog = await import('../../web/lib/catalogActions.js');
const platform = await import('../../web/lib/platformReviewActions.js');
const access = await import('../../web/lib/access.js');
const exportRoute = await import('../../web/app/api/crm/v1/contacts/export/[clientId]/route.js');
const { SYSTEM_ROLE_PERMISSIONS } = await import('../../web/lib/permissions/catalog.js');

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const as = (uid: string | null) => { CURRENT = uid; };
async function refused(fn: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await fn()).ok === false;
  } catch (e) {
    return /refused:/.test(String((e as Error).message));
  }
}
const memberRow = async (tenantId: string, userId: string) =>
  (await query<{ client_role: string | null; access_role_id: string | null; member_client_id: string | null }>(
    `SELECT client_role, access_role_id, member_client_id FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  )).rows[0] ?? null;
const auditActions = async (tenantId: string, clientId: string) =>
  (await query<{ action: string; actor_user_id: string | null; changes: Record<string, unknown> }>(
    `SELECT action, actor_user_id, changes FROM access_audit_events WHERE tenant_id = $1 AND client_id = $2 ORDER BY created_at`,
    [tenantId, clientId],
  )).rows;
/** Effective permissions of a login, resolved exactly like a request does. */
const permsOf = async (userId: string) => {
  const r = access.buildScope(userId, await getMembershipForUser(userId));
  return r.ok ? [...r.scope.permissions].sort() : null;
};

interface World {
  s: Scenario;
  agency: string;
  owner: string;
  owner2: string;
  setter: string;
  staff: string;
  plain: string; // a business login that will receive custom roles
  otherClientOwner: string;
  foreignOwner: string;
  foreign: Scenario;
}
async function world(): Promise<World> {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  const foreign = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId, foreign.tenantId);
  const agency = await seedMember(s.tenantId, { role: 'owner' });
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const owner2 = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const staff = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  await setMemberClientRole({ tenantId: s.tenantId, userId: staff, clientId: s.clientId, clientRole: 'staff', siteId: s.siteId, staffId: s.staffA });
  const plain = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const otherClientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  const foreignOwner = await seedMember(foreign.tenantId, { role: 'owner' });
  return { s, agency, owner, owner2, setter, staff, plain, otherClientOwner, foreignOwner, foreign };
}

async function createRole(actor: string, clientId: string, name: string, permissions: string[]) {
  as(actor);
  const r = await roles.createRoleAction({ clientId, name, description: '', permissions });
  assert.equal(r.ok, true, `create «${name}»: ${'error' in r ? r.error : ''}`);
  return r as { ok: true; id: string; version: number };
}
async function assign(actor: string, w: World, target: string, roleId: string) {
  as(actor);
  return members.changeClientRoleAction({ targetUserId: target, clientId: w.s.clientId, clientRole: 'custom', accessRoleId: roleId });
}

test('compatibility: existing system-role logins keep exactly their previous permissions', async () => {
  const w = await world();
  for (const [uid, key] of [[w.owner, 'owner'], [w.setter, 'setter'], [w.staff, 'staff']] as const) {
    const row = await memberRow(w.s.tenantId, uid);
    assert.equal(row?.client_role, key, 'client_role untouched by the migration');
    assert.equal(row?.access_role_id, null);
    assert.deepEqual(await permsOf(uid), [...SYSTEM_ROLE_PERMISSIONS[key]].sort(), `${key} = its system set`);
  }
  // The DB keeps the invariants: a custom member needs a role; a role must be of the same business.
  await assert.rejects(
    query(`UPDATE tenant_members SET client_role = 'custom' WHERE tenant_id = $1 AND user_id = $2`, [w.s.tenantId, w.plain]),
    /tenant_members_client_role_check/,
  );
});

test('a custom role is its permissions: direct calls without them are refused; renaming changes nothing', async () => {
  const w = await world();
  const contact = await seedContact(w.s.tenantId, w.s.clientId);
  const r = await createRole(w.owner, w.s.clientId, 'Solo lectura', ['contacts.view']);
  assert.equal((await assign(w.owner, w, w.plain, r.id)).ok, true);
  assert.deepEqual(await permsOf(w.plain), ['contacts.view']);

  as(w.plain);
  // Reading works; every write is refused with the explicit message, nothing written.
  const timeline = await crm.loadContactTimelineAction(w.s.clientId, contact, null, []);
  assert.equal(timeline.ok, true, 'contacts.view reads the timeline');
  const note = await crm.addNoteAction(w.s.clientId, contact, 'hola');
  assert.deepEqual(note, { ok: false, error: access.NO_PERMISSION });
  assert.ok(await refused(() => contacts.deleteContactAction(w.s.clientId, contact)), 'no contacts.delete');
  assert.ok(await refused(() => roles.createRoleAction({ clientId: w.s.clientId, name: 'Escalada', permissions: ['contacts.view'] })), 'no roles.manage');
  // The export API (a direct HTTP call) needs contacts.export: 404 without it.
  const res = await exportRoute.GET(new Request(`http://x/api/crm/v1/contacts/export/${w.s.clientId}`), { params: Promise.resolve({ clientId: w.s.clientId }) });
  assert.equal(res.status, 404);

  // Renaming the role to «Dueño»-like or anything else never changes what it can do.
  as(w.owner);
  assert.equal((await roles.updateRoleAction({ clientId: w.s.clientId, roleId: r.id, version: r.version, name: 'Coordinación general', permissions: ['contacts.view'] })).ok, true);
  assert.deepEqual(await permsOf(w.plain), ['contacts.view'], 'same permissions after the rename');
  assert.ok(await refused(() => roles.createRoleAction({ clientId: w.s.clientId, name: 'dueño', permissions: [] })), 'a system role name is refused');
  assert.ok(await refused(() => roles.createRoleAction({ clientId: w.s.clientId, name: 'coordinación GENERAL', permissions: [] })), 'duplicate name refused');
});

test('revocation applies on the next request — no logout, no cache', async () => {
  const w = await world();
  const contact = await seedContact(w.s.tenantId, w.s.clientId);
  const r = await createRole(w.owner, w.s.clientId, 'Editor de contactos', ['contacts.view', 'contacts.edit']);
  await assign(w.owner, w, w.plain, r.id);

  as(w.plain);
  assert.equal((await crm.addNoteAction(w.s.clientId, contact, 'primera')).ok, true, 'granted');

  // The Dueño takes contacts.edit away while the login's screen is still open…
  as(w.owner);
  const upd = await roles.updateRoleAction({ clientId: w.s.clientId, roleId: r.id, version: r.version, name: 'Editor de contactos', permissions: ['contacts.view'] });
  assert.equal(upd.ok, true);
  // …and its very next call is refused, with a message that says why.
  as(w.plain);
  assert.deepEqual(await crm.addNoteAction(w.s.clientId, contact, 'segunda'), { ok: false, error: access.NO_PERMISSION });
  const notes = await query(`SELECT 1 FROM contact_notes WHERE tenant_id = $1 AND contact_id = $2`, [w.s.tenantId, contact]);
  assert.equal(notes.rowCount, 1, 'only the first note exists');

  // Optimistic concurrency: an editor still holding the old version can't overwrite.
  as(w.owner);
  const stale = await roles.updateRoleAction({ clientId: w.s.clientId, roleId: r.id, version: r.version, name: 'Editor de contactos', permissions: ['contacts.view', 'contacts.edit'] });
  assert.equal(stale.ok, false);
  assert.equal('stale' in stale && stale.stale, true);
});

test('a module not contracted stays closed even when the role includes its permission', async () => {
  const w = await world(); // catalog module OFF
  const r = await createRole(w.owner, w.s.clientId, 'Catálogo', ['products.view', 'products.manage']);
  await assign(w.owner, w, w.plain, r.id);
  as(w.plain);
  const off = await catalog.createProductAction({ clientId: w.s.clientId, name: 'Cera', description: 'Cera de prueba', price: 10 });
  assert.equal(off.ok, false, 'module off → refused');
  await setClientModuleEnabled({ tenantId: w.s.tenantId, clientId: w.s.clientId, moduleKey: 'catalog', enabled: true });
  const on = await catalog.createProductAction({ clientId: w.s.clientId, name: 'Cera', description: 'Cera de prueba', price: 10 });
  assert.equal(on.ok, true, "module on + permission → allowed");
  // Recepción (products.view + stock, no manage) is still refused with the module on.
  as(w.setter);
  assert.ok(await refused(() => catalog.createProductAction({ clientId: w.s.clientId, name: 'Gel', price: 5 })));
});

test('isolation: roles never cross businesses or tenants', async () => {
  const w = await world();
  const r = await createRole(w.owner, w.s.clientId, 'Local', ['contacts.view']);
  // Another business of the SAME tenant: its Dueño can't see, edit, delete or assign it.
  as(w.otherClientOwner);
  assert.ok(await refused(() => roles.updateRoleAction({ clientId: w.s.clientId, roleId: r.id, version: 1, name: 'X', permissions: [] })), 'not its business');
  assert.ok(await refused(() => roles.updateRoleAction({ clientId: w.s.otherClientId, roleId: r.id, version: 1, name: 'X', permissions: [] })), 'role id under its own business does not resolve');
  assert.ok(await refused(() => roles.deleteRoleAction({ clientId: w.s.otherClientId, roleId: r.id })));
  // The agency can't put business A's role on a login of business B (FK + lookup).
  const bLogin = await seedMember(w.s.tenantId, { role: 'member', clientId: w.s.otherClientId, clientRole: 'setter' });
  as(w.agency);
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: bLogin, clientId: w.s.otherClientId, clientRole: 'custom', accessRoleId: r.id })));
  assert.equal((await memberRow(w.s.tenantId, bLogin))?.client_role, 'setter');
  await assert.rejects(
    query(`UPDATE tenant_members SET client_role = 'custom', access_role_id = $3 WHERE tenant_id = $1 AND user_id = $2`, [w.s.tenantId, bLogin, r.id]),
    /tenant_members_access_role_fkey/,
  );
  // Another tenant: nothing resolves.
  as(w.foreignOwner);
  assert.ok(await refused(() => roles.createRoleAction({ clientId: w.s.clientId, name: 'Intrusa', permissions: [] })));
  assert.ok(await refused(() => roles.deleteRoleAction({ clientId: w.s.clientId, roleId: r.id })));
  // A forged tenant/permission set from the browser has no effect: only ids are accepted,
  // and the role's permissions are re-read from the DB.
  const still = await query(`SELECT name FROM access_roles WHERE id = $1`, [r.id]);
  assert.equal(still.rows[0]?.name, 'Local');
});

test('delegation: no self-escalation, nothing wider than your own set, the Dueño tier is the agency\'s', async () => {
  const w = await world();
  // The Dueño delegates user + role administration, bounded (approved decision 3).
  const coordPerms = ['access.users.view', 'access.users.manage', 'access.roles.manage', 'contacts.view', 'contacts.edit'];
  const coord = await createRole(w.owner, w.s.clientId, 'Coordinación', coordPerms);
  assert.equal((await assign(w.owner, w, w.plain, coord.id)).ok, true);

  as(w.plain);
  // Its own role: off-limits (no widening, no narrowing).
  assert.ok(await refused(() => roles.updateRoleAction({ clientId: w.s.clientId, roleId: coord.id, version: coord.version, name: 'Coordinación', permissions: [...coordPerms, 'contacts.export'] })));
  // A role with something it doesn't hold: refused.
  assert.ok(await refused(() => roles.createRoleAction({ clientId: w.s.clientId, name: 'Exportadora', permissions: ['contacts.view', 'contacts.export'] })));
  // Within its set: allowed.
  const sub = await roles.createRoleAction({ clientId: w.s.clientId, name: 'Apoyo', permissions: ['contacts.view'] });
  assert.equal(sub.ok, true);
  // Giving Recepción (wider: inbox, agenda, export…) or Dueño: refused.
  const target = await seedMember(w.s.tenantId, { role: 'member', clientId: w.s.clientId, clientRole: 'setter' });
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: target, clientId: w.s.clientId, clientRole: 'owner' })), 'never Dueño');
  assert.ok(await refused(() => invites.createInvitationAction({ email: 'qa-r@example.test', role: 'member', memberClientId: w.s.clientId, clientRole: 'setter' })), 'never a wider role');
  // Acting on a wider login (Recepción, a Dueño) or on itself: refused.
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: target, clientId: w.s.clientId, clientRole: 'custom', accessRoleId: (sub as { id: string }).id })), 'Recepción is wider');
  assert.ok(await refused(() => members.removeMemberAction({ targetUserId: w.owner })), 'a Dueño');
  assert.ok(await refused(() => members.removeMemberAction({ targetUserId: w.plain })), 'itself');
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.plain, clientId: w.s.clientId, clientRole: 'custom', accessRoleId: (sub as { id: string }).id })), 'its own role');
  // A narrower login: manageable.
  const junior = await seedMember(w.s.tenantId, { role: 'member', clientId: w.s.clientId, clientRole: 'setter' });
  as(w.owner);
  await members.changeClientRoleAction({ targetUserId: junior, clientId: w.s.clientId, clientRole: 'custom', accessRoleId: (sub as { id: string }).id });
  as(w.plain);
  assert.equal((await members.removeMemberAction({ targetUserId: junior })).ok, true, 'within its authority');

  // A Dueño never mints a Dueño and can't touch the agency tier.
  as(w.owner);
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.setter, clientId: w.s.clientId, clientRole: 'owner' })));
  assert.ok(await refused(() => invites.createInvitationAction({ email: 'qa-a@example.test', role: 'admin' })));
  // The agency may give a business role an agency-only-by-default key (contacts.delete)…
  const purge = await createRole(w.agency, w.s.clientId, 'Limpieza', ['contacts.view', 'contacts.edit', 'contacts.delete']);
  // …which the Dueño could never have created, and now can't edit (it holds no contacts.delete).
  as(w.owner);
  assert.ok(await refused(() => roles.updateRoleAction({ clientId: w.s.clientId, roleId: purge.id, version: purge.version, name: 'Limpieza', permissions: ['contacts.view'] })));
  // …and agency-only keys that no business role may hold are refused outright.
  as(w.agency);
  assert.ok(await refused(() => roles.createRoleAction({ clientId: w.s.clientId, name: 'Reuniones+', permissions: ['meetings.view', 'meetings.manage'] })));
});

test('the last Dueño is protected; a second one can be demoted only by the agency', async () => {
  const w = await world();
  as(w.agency);
  assert.equal((await members.changeClientRoleAction({ targetUserId: w.owner2, clientId: w.s.clientId, clientRole: 'setter' })).ok, true, 'two Dueños → one may go');
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.owner, clientId: w.s.clientId, clientRole: 'setter' })), 'the last one stays');
  assert.ok(await refused(() => members.removeMemberAction({ targetUserId: w.owner })), 'and can\'t be removed');
  assert.equal((await memberRow(w.s.tenantId, w.owner))?.client_role, 'owner');
});

test('a professional login stays on its own agenda; the review importer is platform-only', async () => {
  const w = await world();
  const contact = await seedContact(w.s.tenantId, w.s.clientId);
  as(w.staff);
  assert.deepEqual(await permsOf(w.staff), ['agenda.book', 'agenda.view']);
  assert.ok(await refused(() => crm.addNoteAction(w.s.clientId, contact, 'x')), 'no CRM');
  // A custom role can never carry the staff binding (DB CHECK) — the Profesional scope
  // stays on the system role.
  const r = await createRole(w.owner, w.s.clientId, 'Agenda+', ['agenda.view', 'agenda.book']);
  await assert.rejects(
    query(`UPDATE tenant_members SET client_role = 'custom', access_role_id = $3 WHERE tenant_id = $1 AND user_id = $2`, [w.s.tenantId, w.staff, r.id]),
    /tenant_members_client_role_check/,
  );
  // Importing / validating external reviews: no business login reaches it, whatever its role.
  const everything = await createRole(w.owner, w.s.clientId, 'Todo', [...SYSTEM_ROLE_PERMISSIONS.owner]);
  await assign(w.owner, w, w.plain, everything.id);
  for (const uid of [w.owner, w.plain, w.agency]) {
    as(uid);
    assert.equal((await platform.searchSitesAction('Test')).ok, false, 'platform allow-list only');
  }
});

test('an assigned role can\'t be deleted until its logins and invitations are resolved; everything is audited', async () => {
  const w = await world();
  const r = await createRole(w.owner, w.s.clientId, 'Marketing', ['campaigns.view']);
  await assign(w.owner, w, w.plain, r.id);
  as(w.owner);
  const inv = await invites.createInvitationAction({ email: 'qa-mkt@example.test', role: 'member', memberClientId: w.s.clientId, clientRole: 'custom', accessRoleId: r.id });
  assert.equal(inv.ok, true);

  const blocked = await roles.deleteRoleAction({ clientId: w.s.clientId, roleId: r.id });
  assert.equal(blocked.ok, false, 'held by a login');
  await members.changeClientRoleAction({ targetUserId: w.plain, clientId: w.s.clientId, clientRole: 'setter' });
  assert.equal((await roles.deleteRoleAction({ clientId: w.s.clientId, roleId: r.id })).ok, false, 'still offered by a pending invitation');
  const invId = (await query<{ id: string }>(`SELECT id FROM invitations WHERE tenant_id = $1 AND email = 'qa-mkt@example.test'`, [w.s.tenantId])).rows[0].id;
  assert.equal((await invites.revokeInvitationAction(invId)).ok, true);
  assert.equal((await roles.deleteRoleAction({ clientId: w.s.clientId, roleId: r.id })).ok, true, 'free → deleted');

  const trail = await auditActions(w.s.tenantId, w.s.clientId);
  assert.deepEqual(trail.map((e) => e.action), [
    'role.created',
    'member.role_changed',
    'invitation.created',
    'member.role_changed',
    'invitation.revoked',
    'role.deleted',
  ]);
  assert.ok(trail.every((e) => e.actor_user_id === w.owner), 'who did it');
  assert.deepEqual(trail[0].changes, { name: 'Marketing', permissions: ['campaigns.view'] });
  assert.deepEqual((trail[1].changes as { to: unknown }).to, { kind: 'custom', id: r.id, label: 'Marketing' });
  // Only structural facts — never message content or tokens.
  assert.ok(!JSON.stringify(trail).match(/token|hola|body/i));
  // A refused attempt writes nothing.
  as(w.setter);
  await roles.createRoleAction({ clientId: w.s.clientId, name: 'No', permissions: [] });
  assert.equal((await auditActions(w.s.tenantId, w.s.clientId)).length, trail.length);
});

test('the agency adjusts a protected role for ONE business; the Dueño can\'t; reset restores the default', async () => {
  const w = await world();
  const otherSetter = await seedMember(w.s.tenantId, { role: 'member', clientId: w.s.otherClientId, clientRole: 'setter' });
  const before = [...SYSTEM_ROLE_PERMISSIONS.setter].sort();
  // The Dueño edits custom roles, never the protected ones.
  as(w.owner);
  assert.ok(await refused(() => roles.updateSystemRoleAction({ clientId: w.s.clientId, systemKey: 'setter', version: null, permissions: ['inbox.view'] })));
  assert.ok(await refused(() => roles.resetSystemRoleAction({ clientId: w.s.clientId, systemKey: 'setter' })));
  // …but still creates, edits and deletes its own (unassigned) custom roles.
  const own = await createRole(w.owner, w.s.clientId, 'Propio', ['contacts.view']);
  assert.equal((await roles.updateRoleAction({ clientId: w.s.clientId, roleId: own.id, version: own.version, name: 'Propio', permissions: ['contacts.view', 'contacts.edit'] })).ok, true);
  assert.equal((await roles.deleteRoleAction({ clientId: w.s.clientId, roleId: own.id })).ok, true);

  // The agency removes the export from Recepción in business A only.
  as(w.agency);
  const adjusted = before.filter((k) => k !== 'contacts.export');
  const r = await roles.updateSystemRoleAction({ clientId: w.s.clientId, systemKey: 'setter', version: null, permissions: adjusted });
  assert.equal(r.ok, true);
  assert.deepEqual(await permsOf(w.setter), adjusted, 'Recepción of A changed on its next request');
  assert.deepEqual(await permsOf(otherSetter), before, 'Recepción of B kept the default');
  assert.equal((await memberRow(w.s.tenantId, w.setter))?.client_role, 'setter', 'the membership itself is untouched');
  as(w.setter);
  const res = await exportRoute.GET(new Request(`http://x/api/crm/v1/contacts/export/${w.s.clientId}`), { params: Promise.resolve({ clientId: w.s.clientId }) });
  assert.equal(res.status, 404, 'the export is closed for Recepción of A');

  // Concurrency: an editor that opened it before the first save is stale.
  as(w.agency);
  const stale = await roles.updateSystemRoleAction({ clientId: w.s.clientId, systemKey: 'setter', version: null, permissions: before });
  assert.equal(stale.ok, false);
  // Widened past the Dueño: it can no longer hand Recepción out in A.
  assert.equal((await roles.updateSystemRoleAction({ clientId: w.s.clientId, systemKey: 'setter', version: (r as { version: number }).version, permissions: [...before, 'contacts.delete'] })).ok, true);
  const newbie = await seedMember(w.s.tenantId, { role: 'member', clientId: w.s.clientId, clientRole: 'setter' });
  await members.changeClientRoleAction({ targetUserId: newbie, clientId: w.s.clientId, clientRole: 'staff', siteId: w.s.siteId, staffId: w.s.staffB });
  as(w.owner);
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: newbie, clientId: w.s.clientId, clientRole: 'setter' })), 'Recepción of A is now wider than the Dueño');

  // Reset → the default again, for A.
  as(w.agency);
  assert.equal((await roles.resetSystemRoleAction({ clientId: w.s.clientId, systemKey: 'setter' })).ok, true);
  assert.deepEqual(await permsOf(w.setter), before);
  const trail = (await auditActions(w.s.tenantId, w.s.clientId)).filter((e) => (e.changes as { system?: string }).system === 'setter');
  assert.equal(trail.length, 3, 'two adjustments + the reset are audited');
  assert.deepEqual((trail[0].changes as { removed: string[] }).removed, ['contacts.export']);
  assert.equal((trail[2].changes as { reset?: boolean }).reset, true);
});
