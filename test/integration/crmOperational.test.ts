import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import * as notes from '../../src/db/repositories/contactNotes.js';
import * as tasks from '../../src/db/repositories/crmTasks.js';
import * as tags from '../../src/db/repositories/contactTags.js';
import { getContactTimeline } from '../../src/db/repositories/contactTimeline.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { linkConversationToContact } from '../../src/db/repositories/contacts.js';
import {
  cleanupTenant,
  closeDb,
  removeMember,
  seedContact,
  seedMember,
  seedScenario,
  seedWorkflow,
} from './fixtures.js';

/**
 * Operational-CRM phase 1 (contact_notes, crm_tasks, contact_tags, timeline),
 * proven behaviorally against PostgreSQL: cross-client/tenant isolation, the
 * composite-FK guarantee, task lifecycle + events (same transaction), tag rules,
 * the unified timeline, and history preservation when a member leaves.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function eventCount(tenantId: string, contactId: string, type?: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int n FROM crm_activity_events WHERE tenant_id = $1 AND contact_id = $2 ${type ? 'AND event_type = $3' : ''}`,
    type ? [tenantId, contactId, type] : [tenantId, contactId],
  );
  return r.rows[0].n;
}

test('notes: create writes entity + event in one tx; list is client-scoped; cross-client contactId → null', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const author = await seedMember(s.tenantId);
  const contactA = await seedContact(s.tenantId, s.clientId);
  const contactB = await seedContact(s.tenantId, s.otherClientId);

  const note = await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contactA, body: 'Called, will return', createdByUserId: author });
  assert.ok(note, 'note created');
  assert.equal(await eventCount(s.tenantId, contactA, 'note_created'), 1, 'note_created event in same tx');

  const listA = await notes.listNotesForContact(s.tenantId, s.clientId, contactA);
  assert.equal(listA.length, 1);
  // Client B never sees A's note (scoped list).
  assert.equal((await notes.listNotesForContact(s.tenantId, s.otherClientId, contactA)).length, 0, 'wrong client → empty');
  // A note write against a contact of ANOTHER client → null (generic), no write.
  const cross = await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contactB, body: 'x', createdByUserId: author });
  assert.equal(cross, null, 'cross-client contactId writes nothing');
});

test('notes: soft delete hides from list but keeps the row + records note_deleted; author edit works', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const u = await seedMember(s.tenantId);
  const contact = await seedContact(s.tenantId, s.clientId);
  const note = (await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, body: 'first', createdByUserId: u }))!;

  await notes.updateNote({ tenantId: s.tenantId, clientId: s.clientId, noteId: note.id, body: 'edited', actorUserId: u });
  await notes.softDeleteNote({ tenantId: s.tenantId, clientId: s.clientId, noteId: note.id, actorUserId: u });

  assert.equal((await notes.listNotesForContact(s.tenantId, s.clientId, contact)).length, 0, 'soft-deleted → hidden');
  const stillThere = await query(`SELECT deleted_at FROM contact_notes WHERE id = $1`, [note.id]);
  assert.equal(stillThere.rowCount, 1, 'row preserved');
  assert.ok(stillThere.rows[0].deleted_at, 'deleted_at set');
  assert.equal(await eventCount(s.tenantId, contact, 'note_updated'), 1);
  assert.equal(await eventCount(s.tenantId, contact, 'note_deleted'), 1);
});

test('composite FK: a note cannot reference a contact of another client (DB rejects)', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const contactA = await seedContact(s.tenantId, s.clientId);
  // Raw insert with client_id = B but contact of A → FK (contact_id,tenant,client) fails.
  await assert.rejects(
    () => query(
      `INSERT INTO contact_notes (tenant_id, client_id, contact_id, body) VALUES ($1, $2, $3, 'x')`,
      [s.tenantId, s.otherClientId, contactA],
    ),
    /foreign key|violates/i,
    'cross-client note insert is impossible',
  );
});

test('tasks: lifecycle sets/clears completed_at, overdue works, events written in-tx, client-scoped', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const creator = await seedMember(s.tenantId, { role: 'owner' });
  const contact = await seedContact(s.tenantId, s.clientId);
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000);

  const t = (await tasks.createTask({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, title: 'Follow up', dueAt: yesterday, assignedToUserId: creator, createdByUserId: creator }))!;
  assert.ok(t && t.status === 'open' && t.completed_at === null);
  assert.equal(await eventCount(s.tenantId, contact, 'task_created'), 1);

  const done = (await tasks.completeTask({ tenantId: s.tenantId, clientId: s.clientId, taskId: t.id, actorUserId: creator }))!;
  assert.equal(done.status, 'completed');
  assert.ok(done.completed_at, 'completed_at set');
  const reopened = (await tasks.reopenTask({ tenantId: s.tenantId, clientId: s.clientId, taskId: t.id, actorUserId: creator }))!;
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.completed_at, null, 'completed_at cleared on reopen');

  // Overdue summary (batched, no N+1).
  const summ = await tasks.openTaskSummaryByContacts(s.tenantId, s.clientId, [contact]);
  assert.equal(summ.get(contact)?.overdue_count, 1, 'overdue task counted');

  await tasks.cancelTask({ tenantId: s.tenantId, clientId: s.clientId, taskId: t.id, actorUserId: creator });
  assert.equal((await tasks.getTaskById(s.tenantId, s.clientId, t.id))!.status, 'cancelled');
  assert.equal(await eventCount(s.tenantId, contact, 'task_completed'), 1);
  assert.equal(await eventCount(s.tenantId, contact, 'task_reopened'), 1);
  assert.equal(await eventCount(s.tenantId, contact, 'task_cancelled'), 1);

  // Client B never sees A's task.
  assert.equal(await tasks.getTaskById(s.tenantId, s.otherClientId, t.id), null, 'wrong client → null');
});

test('tags: case-insensitive unique per client; same name across clients OK; attach idempotent; detach; delete keeps contact', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const u = await seedMember(s.tenantId);
  const contact = await seedContact(s.tenantId, s.clientId);

  const vip = await tags.createTag({ tenantId: s.tenantId, clientId: s.clientId, name: 'VIP', color: 'amber' });
  assert.ok(vip.ok);
  // Case-insensitive duplicate in the SAME client → rejected.
  const dup = await tags.createTag({ tenantId: s.tenantId, clientId: s.clientId, name: 'vip', color: 'red' });
  assert.equal(dup.ok, false);
  // SAME name in ANOTHER client → allowed.
  const bVip = await tags.createTag({ tenantId: s.tenantId, clientId: s.otherClientId, name: 'VIP', color: 'blue' });
  assert.ok(bVip.ok);

  const tagId = vip.ok ? vip.tag.id : '';
  const a1 = await tags.attachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId, actorUserId: u });
  const a2 = await tags.attachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId, actorUserId: u });
  assert.equal(a1.added, true);
  assert.equal(a2.added, false, 'attach idempotent (no second link/event)');
  assert.equal((await tags.listTagsForContact(s.tenantId, s.clientId, contact)).length, 1);
  assert.equal(await eventCount(s.tenantId, contact, 'tag_added'), 1);

  // Attaching client B's tag to client A's contact → rejected (not this client's tag).
  const crossTag = bVip.ok ? bVip.tag.id : '';
  const bad = await tags.attachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId: crossTag, actorUserId: u });
  assert.equal(bad.ok, false, "another client's tag cannot attach");

  await tags.detachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId, actorUserId: u });
  assert.equal((await tags.listTagsForContact(s.tenantId, s.clientId, contact)).length, 0);
  assert.equal(await eventCount(s.tenantId, contact, 'tag_removed'), 1);

  // Re-attach then delete the tag → link gone, contact intact.
  await tags.attachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId, actorUserId: u });
  assert.equal(await tags.deleteTag(s.tenantId, s.clientId, tagId), true);
  assert.equal((await query(`SELECT 1 FROM contact_tag_links WHERE tag_id = $1`, [tagId])).rowCount, 0, 'links removed');
  assert.equal((await query(`SELECT 1 FROM contacts WHERE id = $1`, [contact])).rowCount, 1, 'contact NOT deleted');
});

test('ex-member: deleting a membership preserves history via SET NULL', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const u = await seedMember(s.tenantId);
  const contact = await seedContact(s.tenantId, s.clientId);
  const note = (await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, body: 'by leaver', createdByUserId: u }))!;

  await removeMember(s.tenantId, u);
  const row = (await query<{ created_by_user_id: string | null }>(`SELECT created_by_user_id FROM contact_notes WHERE id = $1`, [note.id])).rows[0];
  assert.equal(row.created_by_user_id, null, 'author nulled, note preserved');
  assert.equal((await query(`SELECT 1 FROM contact_notes WHERE id = $1`, [note.id])).rowCount, 1);
});

test('timeline: combines all 5 sources, DESC order, cursor pagination without duplicates, client-scoped', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const u = await seedMember(s.tenantId);
  const contact = await seedContact(s.tenantId, s.clientId);
  const otherContact = await seedContact(s.tenantId, s.otherClientId);

  // note + task + a crm meta event (stage_changed) + conversation + appointment.
  await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, body: 'n', createdByUserId: u });
  await tasks.createTask({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, title: 'T', assignedToUserId: u, createdByUserId: u });
  await query(
    `INSERT INTO crm_activity_events (tenant_id, client_id, contact_id, event_type, actor_user_id, detail)
       VALUES ($1,$2,$3,'stage_changed',$4,'{"from":"new","to":"active"}')`,
    [s.tenantId, s.clientId, contact, u],
  );
  await seedWorkflow(s.tenantId, s.clientId, 'wf-tl');
  const conv = await getOrCreateConversation(s.tenantId, 'wf-tl', `ref-${randomUUID().slice(0, 6)}`);
  await linkConversationToContact(s.tenantId, conv.id, contact);
  const start = new Date('2027-02-01T15:00:00Z');
  await query(
    `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, contact_id, start_at, service_end_at, blocked_from, blocked_until, service_name_snapshot, duration_min_snapshot, origin, created_by_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,'Haircut',60,'internal','system')`,
    [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, contact, start, new Date(start.getTime() + 3600000)],
  );

  const page1 = await getContactTimeline(s.tenantId, s.clientId, contact, { limit: 3 });
  const types = new Set(page1.items.map((i) => i.sourceType));
  // Page through everything and collect all source types + ids.
  const seen = new Set<string>();
  let cursor: string | null = page1.nextCursor;
  page1.items.forEach((i) => seen.add(i.id));
  const allTypes = new Set(page1.items.map((i) => i.sourceType));
  let guard = 0;
  while (cursor && guard++ < 10) {
    const p: Awaited<ReturnType<typeof getContactTimeline>> = await getContactTimeline(s.tenantId, s.clientId, contact, { cursor, limit: 3 });
    for (const i of p.items) {
      assert.ok(!seen.has(i.id), `no duplicate across pages: ${i.id}`);
      seen.add(i.id);
      allTypes.add(i.sourceType);
    }
    cursor = p.nextCursor;
  }
  for (const src of ['crm', 'note', 'task', 'appointment', 'conversation'] as const) {
    assert.ok(allTypes.has(src), `timeline includes a ${src} item`);
  }
  // DESC order within the first page.
  for (let i = 1; i < page1.items.length; i++) {
    assert.ok(page1.items[i - 1].occurredAt.getTime() >= page1.items[i].occurredAt.getTime(), 'descending');
  }
  void types;

  // Client B's contact timeline never shows client A's items (and vice versa).
  const bTimeline = await getContactTimeline(s.tenantId, s.otherClientId, otherContact, { limit: 50 });
  assert.equal(bTimeline.items.length, 0, "another client's contact has no cross items");
});
