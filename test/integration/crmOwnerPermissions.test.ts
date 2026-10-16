import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario } from './fixtures.js';

/**
 * MF-1 item 5 — a Client Owner has FULL CRM control inside their own client; Setter/Staff
 * keep the narrow rules; a Client Owner of client A gets nothing in client B.
 *
 * BEHAVIORAL: real actions + real seeded scope; only the session read + Next boundaries are
 * stubbed (same technique as timeOffPermissions.test.ts / connectionActionsPermissions).
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: {
    getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null),
  },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: () => { throw new Error('unexpected redirect()'); },
    notFound: () => { throw new Error('unexpected notFound()'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (userId: string) => { CURRENT = { id: userId, email: `${userId.slice(0, 8)}@test.local` }; };

const {
  addNoteAction, editNoteAction, createTaskAction, reassignTaskAction,
  createTagAction, renameTagAction,
} = await import('../../web/lib/crmActions.js');

after(closeDb);

/** A STAFF login needs its scheduling binding (DB CHECK) — bind it to the seeded site/staff. */
async function seedStaffLogin(tenantId: string, clientId: string, siteId: string, staffId: string): Promise<string> {
  const userId = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Staff', $2, true)`, [userId, `staff-${userId.slice(0, 8)}@test.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
       VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
    [tenantId, userId, clientId, siteId, staffId],
  );
  return userId;
}
const refused = (r: { ok: boolean }) => r.ok === false;

test('item 5: a Client Owner has full CRM control inside their client', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const clientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead' });

    // The SETTER creates a note + a task (owned by the setter — "foreign" to the owner).
    asUser(setter);
    const note = await addNoteAction(s.clientId, contact, 'nota del setter');
    assert.equal(note.ok && !!note.id, true);
    const task = await createTaskAction(s.clientId, contact, { title: 'tarea del setter', assignedToUserId: setter });
    assert.equal(task.ok && !!task.id, true);
    const noteId = note.ok ? note.id! : '';
    const taskId = task.ok ? task.id! : '';

    // The CLIENT OWNER manages both, though it authored neither.
    asUser(clientOwner);
    assert.equal((await editNoteAction(s.clientId, noteId, 'editada por el dueño')).ok, true, 'edits any note');
    assert.equal((await reassignTaskAction(s.clientId, taskId, clientOwner)).ok, true, 'manages/reassigns any task');
    // ... and manages the tag catalogue.
    const tag = await createTagAction(s.clientId, 'VIP', 'gray');
    assert.equal(tag.ok && !!tag.id, true, 'creates a tag');
    assert.equal((await renameTagAction(s.clientId, tag.ok ? tag.id! : '', 'VIP+')).ok, true, 'renames a tag');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('item 5: Setter and Staff keep the narrow rules (unchanged)', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const staff = await seedStaffLogin(s.tenantId, s.clientId, s.siteId, s.staffA);
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead' });

    // The owner authors a note (foreign to setter/staff).
    asUser(owner);
    const note = await addNoteAction(s.clientId, contact, 'nota del dueño');
    const noteId = note.ok ? note.id! : '';
    const task = await createTaskAction(s.clientId, contact, { title: 't', assignedToUserId: owner });
    const taskId = task.ok ? task.id! : '';

    // SETTER: limited CRM access — refused on anything full-access, but may still create
    // their OWN note (any CRM user may).
    asUser(setter);
    assert.ok(refused(await editNoteAction(s.clientId, noteId, 'intento')), 'setter cannot edit a foreign note');
    assert.ok(refused(await reassignTaskAction(s.clientId, taskId, setter)), 'setter cannot manage a foreign task');
    assert.ok(refused(await createTagAction(s.clientId, 'tag-setter', 'gray')), 'setter cannot manage the tag catalogue');
    assert.equal((await addNoteAction(s.clientId, contact, 'nota propia')).ok, true, 'setter may create own note');

    // STAFF: scheduling-only — NO CRM access at all (today's rule, unchanged). Every CRM
    // action is refused at the client-access gate, including creating a note.
    asUser(staff);
    assert.ok(refused(await addNoteAction(s.clientId, contact, 'nota')), 'staff has no CRM access');
    assert.ok(refused(await editNoteAction(s.clientId, noteId, 'intento')), 'staff cannot edit notes');
    assert.ok(refused(await createTagAction(s.clientId, 'tag-staff', 'gray')), 'staff cannot manage tags');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('item 5: a Client Owner of client A gets nothing in client B', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const ownerOfA = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const contactInB = await seedContact(s.tenantId, s.otherClientId, { name: 'B lead' });
    asUser(ownerOfA);
    // Every action scoped to client B is refused at the client-access gate.
    assert.ok(refused(await addNoteAction(s.otherClientId, contactInB, 'hola')), 'no notes in B');
    assert.ok(refused(await createTaskAction(s.otherClientId, contactInB, { title: 't' })), 'no tasks in B');
    assert.ok(refused(await createTagAction(s.otherClientId, 'X', 'gray')), 'no tag catalogue in B');
    // Nothing was written into client B.
    assert.equal((await query('SELECT count(*)::int n FROM contact_notes WHERE client_id=$1', [s.otherClientId])).rows[0].n, 0);
    assert.equal((await query('SELECT count(*)::int n FROM contact_tags WHERE client_id=$1', [s.otherClientId])).rows[0].n, 0);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
