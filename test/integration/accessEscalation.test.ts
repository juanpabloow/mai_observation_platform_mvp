import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setMemberClientRole } from '../../src/db/repositories/tenantMembers.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, type Scenario } from './fixtures.js';

/**
 * USUARIOS Y ACCESOS + CAMPOS PERSONALIZADOS — no privilege escalation, through the REAL
 * server actions, repositories and PostgreSQL. The only stubs are the session read,
 * Next's request boundaries and the e-mail sender (so no invitation ever leaves).
 *
 *  - Only the AGENCY may mint a Client Owner (role change or invitation) or an admin.
 *  - A Client Owner acts only inside their own client, only on setters/staff.
 *  - Recepción (setter) and Profesional (staff) manage nobody and no field definition.
 *  - Another client of the tenant and another tenant are refused.
 *  - A refused call leaves the database exactly as it was.
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
const SENT: unknown[] = [];
mock.module('../../web/lib/email.ts', {
  namedExports: { isEmailConfigured: false, sendEmail: async (p: unknown) => { SENT.push(p); return { ok: false, error: 'disabled in tests' }; } },
});

const members = await import('../../web/lib/memberActions.js');
const invites = await import('../../web/lib/inviteActions.js');
const fields = await import('../../web/lib/fieldDefinitionActions.js');

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const as = (uid: string | null) => { CURRENT = uid; };
/** Refused = an { ok: false } result or a thrown notFound()/redirect(). */
async function refused(fn: () => Promise<{ ok: boolean }>): Promise<boolean> {
  try {
    return (await fn()).ok === false;
  } catch (e) {
    return /refused:/.test(String((e as Error).message));
  }
}
const roleOf = async (tenantId: string, userId: string) =>
  (await query<{ role: string; member_client_id: string | null; client_role: string | null }>(
    `SELECT role, member_client_id, client_role FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  )).rows[0] ?? null;
const invitationCount = async (tenantId: string) =>
  Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM invitations WHERE tenant_id = $1`, [tenantId])).rows[0].n);
const fieldDefs = async (tenantId: string, clientId: string) =>
  (await query<{ key: string; label: string; enabled: boolean }>(
    `SELECT key, label, enabled FROM client_field_definitions WHERE tenant_id = $1 AND client_id = $2 ORDER BY key`,
    [tenantId, clientId],
  )).rows;

interface World {
  s: Scenario;
  agency: string;
  owner: string;
  setter: string;
  staff: string;
  otherClientOwner: string;
  otherClientSetter: string;
  foreignOwner: string;
}
async function world(opts: { crm?: boolean } = {}): Promise<World> {
  const s = await seedScenario({ enableScheduling: true, enableCrm: opts.crm ?? true });
  const other = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId, other.tenantId);
  const agency = await seedMember(s.tenantId, { role: 'owner' });
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const staff = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  await setMemberClientRole({ tenantId: s.tenantId, userId: staff, clientId: s.clientId, clientRole: 'staff', siteId: s.siteId, staffId: s.staffA });
  const otherClientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
  const otherClientSetter = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'setter' });
  const foreignOwner = await seedMember(other.tenantId, { role: 'owner' });
  return { s, agency, owner, setter, staff, otherClientOwner, otherClientSetter, foreignOwner };
}

test('Usuarios y accesos: a Client Owner can not mint an Owner or an admin, nor act outside their client', async () => {
  const w = await world();
  const { s } = w;
  const before = { setter: await roleOf(s.tenantId, w.setter), invites: await invitationCount(s.tenantId) };

  as(w.owner);
  // Promote a setter to Owner: refused, and the row is untouched.
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.setter, clientId: s.clientId, clientRole: 'owner' })), 'owner → mint an Owner');
  // Invite an Owner or an admin: refused, no invitation row.
  assert.ok(await refused(() => invites.createInvitationAction({ email: 'qa-owner@example.test', role: 'member', memberClientId: s.clientId, clientRole: 'owner' })), 'owner → invite an Owner');
  assert.ok(await refused(() => invites.createInvitationAction({ email: 'qa-admin@example.test', role: 'admin' })), 'owner → invite an admin');
  // Agency-tier actions: refused.
  assert.ok(await refused(() => members.changeMemberRoleAction({ targetUserId: w.setter, newRole: 'admin' })), 'owner → make an admin');
  assert.ok(await refused(() => members.changeMemberRoleAction({ targetUserId: w.owner, newRole: 'admin' })), 'owner → make THEMSELVES admin');
  assert.ok(await refused(() => members.reassignMemberClientAction({ targetUserId: w.otherClientSetter, clientId: s.clientId })), 'owner → pull a member from another client');
  // Another client of the same tenant: refused.
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.otherClientSetter, clientId: s.otherClientId, clientRole: 'staff', siteId: s.siteId, staffId: s.staffA })), 'owner → another client');
  assert.ok(await refused(() => members.removeMemberAction({ targetUserId: w.otherClientSetter })), 'owner → remove in another client');
  assert.ok(await refused(() => invites.createInvitationAction({ email: 'qa-x@example.test', role: 'member', memberClientId: s.otherClientId, clientRole: 'setter' })), 'owner → invite into another client');
  // Self-escalation and touching an Owner: refused (also the last Owner).
  assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.owner, clientId: s.clientId, clientRole: 'setter' })), 'owner → demote themselves (last owner)');
  assert.ok(await refused(() => members.removeMemberAction({ targetUserId: w.owner })), 'owner → remove themselves');

  assert.deepEqual(await roleOf(s.tenantId, w.setter), before.setter, 'the setter is still a setter');
  assert.equal((await roleOf(s.tenantId, w.owner))?.client_role, 'owner');
  assert.equal((await roleOf(s.tenantId, w.otherClientSetter))?.member_client_id, s.otherClientId);
  assert.equal(await invitationCount(s.tenantId), before.invites, 'no invitation was written');

  // What a Client Owner MAY do still works: invite a setter to their own client (the
  // e-mail is stubbed — nothing is sent).
  const ok = await invites.createInvitationAction({ email: 'qa-recepcion@example.test', role: 'member', memberClientId: s.clientId, clientRole: 'setter' });
  assert.equal(ok.ok, true);
  const inv = await query<{ role: string; client_role: string; member_client_id: string }>(
    `SELECT role, client_role, member_client_id FROM invitations WHERE tenant_id = $1 AND email = 'qa-recepcion@example.test'`,
    [s.tenantId],
  );
  assert.deepEqual(inv.rows[0], { role: 'member', client_role: 'setter', member_client_id: s.clientId });

  // …and only the agency may promote to Owner.
  as(w.agency);
  assert.equal((await members.changeClientRoleAction({ targetUserId: w.setter, clientId: s.clientId, clientRole: 'owner' })).ok, true);
  assert.equal((await roleOf(s.tenantId, w.setter))?.client_role, 'owner');
});

test('Usuarios y accesos: Recepción, Profesional and another tenant manage nobody', async () => {
  const w = await world();
  const { s } = w;
  const snapshot = async () => ({
    owner: await roleOf(s.tenantId, w.owner),
    setter: await roleOf(s.tenantId, w.setter),
    staff: await roleOf(s.tenantId, w.staff),
    invites: await invitationCount(s.tenantId),
  });
  const before = await snapshot();
  for (const [who, uid] of [['setter', w.setter], ['staff', w.staff], ['other tenant', w.foreignOwner], ['anonymous', null]] as const) {
    as(uid);
    assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.setter, clientId: s.clientId, clientRole: 'owner' })), `${who} → mint an Owner`);
    assert.ok(await refused(() => members.changeClientRoleAction({ targetUserId: w.staff, clientId: s.clientId, clientRole: 'setter' })), `${who} → change a role`);
    assert.ok(await refused(() => members.changeMemberRoleAction({ targetUserId: w.setter, newRole: 'admin' })), `${who} → make an admin`);
    assert.ok(await refused(() => members.removeMemberAction({ targetUserId: w.staff })), `${who} → remove a member`);
    assert.ok(await refused(() => invites.createInvitationAction({ email: 'qa-y@example.test', role: 'member', memberClientId: s.clientId, clientRole: 'setter' })), `${who} → invite`);
  }
  assert.deepEqual(await snapshot(), before, 'nothing changed');
  assert.equal(SENT.length, 1, 'only the one allowed invitation (previous case) reached the stubbed sender');
});

test('Campos personalizados: only the agency or this client\'s Owner manage definitions; values keep on disable', async () => {
  const w = await world();
  const { s } = w;
  as(w.owner);
  assert.equal((await fields.createFieldDefinitionAction(s.clientId, { key: 'qa_estilo', label: 'QA Estilo', type: 'text' })).ok, true);
  const before = await fieldDefs(s.tenantId, s.clientId);
  const id = (await query<{ id: string }>(`SELECT id FROM client_field_definitions WHERE tenant_id = $1 AND client_id = $2 AND key = 'qa_estilo'`, [s.tenantId, s.clientId])).rows[0].id;

  for (const [who, uid] of [['setter', w.setter], ['staff', w.staff], ['other client owner', w.otherClientOwner], ['other tenant', w.foreignOwner], ['anonymous', null]] as const) {
    as(uid);
    assert.ok(await refused(() => fields.createFieldDefinitionAction(s.clientId, { key: 'qa_intruso', label: 'Intruso', type: 'text' })), `${who} → create`);
    assert.ok(await refused(() => fields.updateFieldDefinitionAction(s.clientId, id, { label: 'Cambiado' })), `${who} → rename`);
    assert.ok(await refused(() => fields.updateFieldDefinitionAction(s.clientId, id, { enabled: false })), `${who} → disable`);
  }
  assert.deepEqual(await fieldDefs(s.tenantId, s.clientId), before, 'the definitions are untouched');

  // The agency may — and disabling keeps the definition (key, label) instead of deleting it.
  as(w.agency);
  assert.equal((await fields.updateFieldDefinitionAction(s.clientId, id, { enabled: false })).ok, true);
  assert.deepEqual(await fieldDefs(s.tenantId, s.clientId), [{ key: 'qa_estilo', label: 'QA Estilo', enabled: false }]);
});

test('Campos personalizados: refused while the CRM module is disabled, even for the agency', async () => {
  const w = await world({ crm: false });
  as(w.agency);
  assert.ok(await refused(() => fields.createFieldDefinitionAction(w.s.clientId, { key: 'qa_off', label: 'Off', type: 'text' })));
  assert.deepEqual(await fieldDefs(w.s.tenantId, w.s.clientId), []);
});
