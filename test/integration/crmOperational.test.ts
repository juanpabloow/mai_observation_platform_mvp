import { randomUUID } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import * as notes from '../../src/db/repositories/contactNotes.js';
import * as tasks from '../../src/db/repositories/crmTasks.js';
import * as tags from '../../src/db/repositories/contactTags.js';
import { getContactTimeline } from '../../src/db/repositories/contactTimeline.js';
import { getOrCreateConversation, insertMessage } from '../../src/db/repositories/handoff.js';
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

/** Map a specific item kind → its source category (C-3 unions 4 sources). */
const srcOf = (kind: string): string =>
  kind === 'conversation' ? 'conversation' : kind.startsWith('appointment_') ? 'appointment' : kind === 'note' ? 'note' : 'activity';

test('timeline: ONE entry per conversation, faithful appointment history, all sources interleaved, client-scoped', async () => {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const u = await seedMember(s.tenantId);
  const contact = await seedContact(s.tenantId, s.clientId);
  const otherContact = await seedContact(s.tenantId, s.otherClientId);

  // Two conversations — one CHATTY (30 messages) — linked to the contact.
  await seedWorkflow(s.tenantId, s.clientId, 'wf-tl');
  const conv1 = await getOrCreateConversation(s.tenantId, 'wf-tl', `c1-${randomUUID().slice(0, 6)}`);
  const conv2 = await getOrCreateConversation(s.tenantId, 'wf-tl', `c2-${randomUUID().slice(0, 6)}`);
  await linkConversationToContact(s.tenantId, conv1.id, contact);
  await linkConversationToContact(s.tenantId, conv2.id, contact);
  for (let i = 0; i < 30; i++) {
    await insertMessage({ tenantId: s.tenantId, conversationId: conv1.id, sender: i % 2 ? 'bot' : 'user', text: `m${i}`, status: 'received', occurredAt: new Date(Date.parse('2027-02-01T09:00:00Z') + i * 60000) });
  }
  await insertMessage({ tenantId: s.tenantId, conversationId: conv2.id, sender: 'user', text: 'hi', status: 'received', occurredAt: new Date('2027-02-02T09:00:00Z') });

  // Three appointments in different states — history from appointment_events (faithful).
  const mkAppt = async (start: Date) =>
    (await query<{ id: string }>(
      `INSERT INTO appointments (tenant_id, client_id, site_id, staff_id, service_id, contact_id, start_at, service_end_at, blocked_from, blocked_until, service_name_snapshot, duration_min_snapshot, status, origin, created_by_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$8,'Haircut',60,'completed','internal','system') RETURNING id`,
      [s.tenantId, s.clientId, s.siteId, s.staffA, s.serviceHaircut, contact, start, new Date(start.getTime() + 3600000)],
    )).rows[0].id;
  const mkEvent = (apptId: string, type: string, at: string) =>
    query(`INSERT INTO appointment_events (tenant_id, appointment_id, event_type, actor_type, created_at) VALUES ($1,$2,$3,'agent',$4)`, [s.tenantId, apptId, type, at]);
  const a1 = await mkAppt(new Date('2027-02-03T15:00:00Z'));
  const a2 = await mkAppt(new Date('2027-02-04T15:00:00Z'));
  const a3 = await mkAppt(new Date('2027-02-05T15:00:00Z'));
  await mkEvent(a1, 'appointment_created', '2027-02-03T10:00:00Z');
  await mkEvent(a2, 'appointment_created', '2027-02-04T10:00:00Z');
  await mkEvent(a2, 'appointment_completed', '2027-02-04T16:00:00Z');
  await mkEvent(a3, 'appointment_created', '2027-02-05T10:00:00Z');

  // Two notes, one completed task (→ task_created + task_completed events), two tags.
  await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, body: 'n1', createdByUserId: u });
  await notes.createNote({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, body: 'n2', createdByUserId: u });
  const task = (await tasks.createTask({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, title: 'T', assignedToUserId: u, createdByUserId: u }))!;
  await tasks.completeTask({ tenantId: s.tenantId, clientId: s.clientId, taskId: task.id, actorUserId: u });
  const vip = await tags.createTag({ tenantId: s.tenantId, clientId: s.clientId, name: 'VIP', color: 'amber' });
  const reg = await tags.createTag({ tenantId: s.tenantId, clientId: s.clientId, name: 'Regular', color: 'blue' });
  if (vip.ok) await tags.attachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId: vip.tag.id, actorUserId: u });
  if (reg.ok) await tags.attachTag({ tenantId: s.tenantId, clientId: s.clientId, contactId: contact, tagId: reg.tag.id, actorUserId: u });

  // Two entries from DIFFERENT contexts sharing the SAME occurred_at to the microsecond.
  const SAME = '2027-02-06T12:00:00.123456Z';
  await query(`INSERT INTO crm_activity_events (tenant_id, client_id, contact_id, event_type, actor_user_id, occurred_at) VALUES ($1,$2,$3,'owner_changed',$4,$5),($1,$2,$3,'stage_changed',$4,$5)`, [s.tenantId, s.clientId, contact, u, SAME]);

  // Full single-page snapshot: ONE entry per conversation (not per message).
  const all = await getContactTimeline(s.tenantId, s.clientId, contact, { limit: 100 });
  const convItems = all.items.filter((i) => i.kind === 'conversation');
  assert.equal(convItems.length, 2, 'exactly ONE timeline entry per conversation (30-msg conv is not flooded)');
  const chatty = convItems.find((i) => i.meta.messageCount === 30);
  assert.ok(chatty, 'the chatty conversation entry carries messageCount = 30');
  // Faithful appointment HISTORY (from events, not just current state).
  const apptKinds = all.items.filter((i) => srcOf(i.kind) === 'appointment').map((i) => i.kind);
  assert.ok(apptKinds.includes('appointment_created') && apptKinds.includes('appointment_completed'), 'appointment history includes created + completed events');
  // All four sources present.
  for (const src of ['conversation', 'appointment', 'note', 'activity'] as const) {
    assert.ok(all.items.some((i) => srcOf(i.kind) === src), `timeline includes a ${src} item`);
  }

  // KEYSET pagination (limit 3, ≥4 pages): every entry exactly once, no skip. Insert a
  // NEW note mid-pagination → still no duplicates/skips of the entries being paged.
  const total = all.items.length;
  assert.ok(total >= 12, `enough entries to page (got ${total})`);
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let inserted = false;
  for (;;) {
    const p: Awaited<ReturnType<typeof getContactTimeline>> = await getContactTimeline(s.tenantId, s.clientId, contact, { cursor, limit: 3 });
    pages++;
    for (const i of p.items) {
      assert.ok(!seen.has(i.id), `no duplicate across pages: ${i.id}`);
      seen.add(i.id);
    }
    // DESC order within the page (compare microsecond-precise ISO strings).
    for (let i = 1; i < p.items.length; i++) assert.ok(p.items[i - 1].occurred_at >= p.items[i].occurred_at, 'descending');
    if (!inserted && pages === 1) {
      inserted = true;
      // NEW activity arriving mid-pagination, NEWER than everything (above where we
      // already are) — it must not disturb the downward paging (no dup, no skip).
      await query(`INSERT INTO crm_activity_events (tenant_id, client_id, contact_id, event_type, actor_user_id, occurred_at) VALUES ($1,$2,$3,'stage_changed',$4,'2099-01-01T00:00:00Z')`, [s.tenantId, s.clientId, contact, u]);
    }
    cursor = p.nextCursor;
    if (!cursor || pages > 20) break;
  }
  assert.ok(pages >= 4, `paged across ≥4 pages (got ${pages})`);
  // The two same-microsecond events both surfaced exactly once.
  assert.equal([...seen].filter((id) => id.startsWith('owner_changed:') || id.startsWith('stage_changed:')).length, 2, 'both same-microsecond events appear exactly once');
  assert.equal(seen.size, total, 'paged set equals the full set (nothing skipped; the mid-insert, being newer than the cursor, simply is not re-paged)');

  // Client B's contact timeline never shows client A's items.
  const bTimeline = await getContactTimeline(s.tenantId, s.otherClientId, otherContact, { limit: 50 });
  assert.equal(bTimeline.items.length, 0, "another client's contact has no cross items");
});
