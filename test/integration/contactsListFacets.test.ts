import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { createTask } from '../../src/db/repositories/crmTasks.js';
import {
  listContacts,
  summarizeContacts,
  UNASSIGNED_OWNER,
} from '../../src/db/repositories/contacts.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario } from './fixtures.js';

/**
 * The contacts-list FACETS added by the visual phase (Owner + Tasks) and the
 * summary strip, proven behaviorally against PostgreSQL.
 *
 * These exist because the redesign put real numbers on screen (OPEN TASKS per row,
 * "N tasks overdue" / "N unassigned" in the strip). The rule the phase committed to
 * was: server-side, tenant+client-scoped, bounded — never an N+1 and never a filter
 * that can see another client's rows. That is exactly what is asserted here, plus
 * the invariant that the summary and the list always describe the SAME set.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const HOUR = 60 * 60 * 1000;

test('open/overdue task counts are per-contact, client-scoped, and drive the Tasks facet', async () => {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  const owner = await seedMember(s.tenantId, { role: 'owner' });

  const withOverdue = await seedContact(s.tenantId, s.clientId, { name: 'Has Overdue' });
  const withOpen = await seedContact(s.tenantId, s.clientId, { name: 'Has Open' });
  const clean = await seedContact(s.tenantId, s.clientId, { name: 'Clean' });
  // A contact in ANOTHER client of the same tenant, carrying its own overdue task.
  const foreign = await seedContact(s.tenantId, s.otherClientId, { name: 'Other Client' });

  const mk = (clientId: string, contactId: string, dueAt: Date | null) =>
    createTask({
      tenantId: s.tenantId,
      clientId,
      contactId,
      title: 'Follow up',
      dueAt,
      assignedToUserId: null,
      createdByUserId: owner,
    });

  await mk(s.clientId, withOverdue, new Date(Date.now() - 2 * HOUR)); // overdue
  await mk(s.clientId, withOverdue, new Date(Date.now() + 2 * HOUR)); // open, not overdue
  await mk(s.clientId, withOpen, new Date(Date.now() + 2 * HOUR)); // open only
  await mk(s.otherClientId, foreign, new Date(Date.now() - 2 * HOUR));

  const { items } = await listContacts(s.tenantId, { clientId: s.clientId });
  const by = new Map(items.map((c) => [c.id, c]));
  assert.equal(items.length, 3, 'only this client’s contacts are listed');

  assert.equal(by.get(withOverdue)?.open_task_count, 2);
  assert.equal(by.get(withOverdue)?.overdue_task_count, 1);
  assert.equal(by.get(withOpen)?.open_task_count, 1);
  assert.equal(by.get(withOpen)?.overdue_task_count, 0);
  assert.equal(by.get(clean)?.open_task_count, 0, 'a contact with no tasks counts zero, not null');
  assert.equal(by.get(clean)?.overdue_task_count, 0);

  // The other client's task never counts onto this client's rows…
  assert.equal(by.has(foreign), false);
  // …and the facets narrow correctly.
  const open = await listContacts(s.tenantId, { clientId: s.clientId, tasks: 'open' });
  assert.deepEqual(new Set(open.items.map((c) => c.id)), new Set([withOverdue, withOpen]));
  const overdue = await listContacts(s.tenantId, { clientId: s.clientId, tasks: 'overdue' });
  assert.deepEqual(overdue.items.map((c) => c.id), [withOverdue]);
});

test('a COMPLETED task stops counting as open (the row and the facet agree)', async () => {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  const owner = await seedMember(s.tenantId, { role: 'owner' });
  const contactId = await seedContact(s.tenantId, s.clientId, { name: 'Closer' });

  const task = await createTask({
    tenantId: s.tenantId,
    clientId: s.clientId,
    contactId,
    title: 'Call back',
    dueAt: new Date(Date.now() - HOUR),
    assignedToUserId: null,
    createdByUserId: owner,
  });
  assert.ok(task);

  let { items } = await listContacts(s.tenantId, { clientId: s.clientId });
  assert.equal(items[0].overdue_task_count, 1);

  await query(`UPDATE crm_tasks SET status = 'completed', completed_at = now() WHERE id = $1`, [task.id]);

  ({ items } = await listContacts(s.tenantId, { clientId: s.clientId }));
  assert.equal(items[0].open_task_count, 0, 'completed work leaves the OPEN TASKS column');
  assert.equal(items[0].overdue_task_count, 0);
  const stillOverdue = await listContacts(s.tenantId, { clientId: s.clientId, tasks: 'overdue' });
  assert.equal(stillOverdue.items.length, 0);
});

test('the Owner facet filters by assignee and by the "unassigned" bucket', async () => {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  const alice = await seedMember(s.tenantId, { role: 'admin' });
  const bob = await seedMember(s.tenantId, { role: 'admin' });

  const aliceContact = await seedContact(s.tenantId, s.clientId, { name: 'Alice Owns' });
  const bobContact = await seedContact(s.tenantId, s.clientId, { name: 'Bob Owns' });
  const nobody = await seedContact(s.tenantId, s.clientId, { name: 'Nobody Owns' });
  await query(`UPDATE contacts SET assigned_to = $1 WHERE id = $2`, [alice, aliceContact]);
  await query(`UPDATE contacts SET assigned_to = $1 WHERE id = $2`, [bob, bobContact]);

  const mine = await listContacts(s.tenantId, { clientId: s.clientId, owner: alice });
  assert.deepEqual(mine.items.map((c) => c.id), [aliceContact]);

  const unowned = await listContacts(s.tenantId, { clientId: s.clientId, owner: UNASSIGNED_OWNER });
  assert.deepEqual(unowned.items.map((c) => c.id), [nobody]);

  // 'unassigned' is a SENTINEL, never a user id — it must not match a real owner.
  assert.equal(unowned.items.some((c) => c.id === bobContact), false);
});

test('summarizeContacts describes the same filtered set the list pages through', async () => {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  const owner = await seedMember(s.tenantId, { role: 'owner' });

  const a = await seedContact(s.tenantId, s.clientId, { name: 'Ana New' });
  const b = await seedContact(s.tenantId, s.clientId, { name: 'Beto Active' });
  const c = await seedContact(s.tenantId, s.clientId, { name: 'Caro Customer' });
  await seedContact(s.tenantId, s.otherClientId, { name: 'Foreign Person' });
  await query(`UPDATE contacts SET stage = 'active' WHERE id = $1`, [b]);
  await query(`UPDATE contacts SET stage = 'customer' WHERE id = $1`, [c]);
  await query(`UPDATE contacts SET assigned_to = $1 WHERE id = $2`, [owner, a]);
  await createTask({
    tenantId: s.tenantId,
    clientId: s.clientId,
    contactId: b,
    title: 'Overdue thing',
    dueAt: new Date(Date.now() - HOUR),
    assignedToUserId: null,
    createdByUserId: owner,
  });

  const summary = await summarizeContacts(s.tenantId, { clientId: s.clientId });
  assert.deepEqual(summary, {
    total: 3, // the other client's person is NOT counted
    new: 1,
    active: 1,
    customer: 1,
    overdueTasks: 1, // contacts carrying ≥1 overdue open task
    unassigned: 2,
  });

  // Applying a facet narrows the summary exactly like it narrows the list.
  const activeOnly = await summarizeContacts(s.tenantId, { clientId: s.clientId, stage: 'active' });
  const activeList = await listContacts(s.tenantId, { clientId: s.clientId, stage: 'active' });
  assert.equal(activeOnly.total, activeList.items.length);
  assert.equal(activeOnly.total, 1);

  const searched = await summarizeContacts(s.tenantId, { clientId: s.clientId, search: 'Caro' });
  const searchedList = await listContacts(s.tenantId, { clientId: s.clientId, search: 'Caro' });
  assert.equal(searched.total, searchedList.items.length);
  assert.equal(searched.customer, 1);
});

test('fail-closed: the facets never widen past the client (or leak to another tenant)', async () => {
  const s = await seedScenario({ enableCrm: true });
  const other = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId, other.tenantId);
  const owner = await seedMember(s.tenantId, { role: 'owner' });

  await seedContact(s.tenantId, s.clientId, { name: 'Inside' });
  await seedContact(s.tenantId, s.otherClientId, { name: 'Sibling Client' });
  await seedContact(other.tenantId, other.clientId, { name: 'Other Tenant' });

  // Every facet combination stays inside tenant + client.
  for (const opts of [
    { clientId: s.clientId },
    { clientId: s.clientId, owner: UNASSIGNED_OWNER },
    { clientId: s.clientId, tasks: 'open' as const },
    { clientId: s.clientId, stage: 'new' as const, owner: UNASSIGNED_OWNER },
  ]) {
    const { items } = await listContacts(s.tenantId, opts);
    assert.ok(
      items.every((c) => c.client_id === s.clientId && c.tenant_id === s.tenantId),
      `facet ${JSON.stringify(opts)} stayed inside the client`,
    );
  }

  // A foreign owner id simply matches nothing — it can never surface another
  // tenant's people.
  const foreignOwner = await seedMember(other.tenantId, { role: 'owner' });
  const leaked = await listContacts(s.tenantId, { clientId: s.clientId, owner: foreignOwner });
  assert.equal(leaked.items.length, 0);
  assert.equal((await summarizeContacts(s.tenantId, { clientId: s.clientId, owner: foreignOwner })).total, 0);
  assert.ok(owner);
});
