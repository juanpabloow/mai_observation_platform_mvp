import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query, withTransaction } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { resolveContactByIdentity, backfillConversationContacts } from '../../src/db/repositories/contactIdentities.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { listContactConversations, linkConversationToContact } from '../../src/db/repositories/contacts.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * E-5: a contact resolved/created from an identity auto-links this client's unlinked
 * conversations of the same phone, so the record shows the chat, not just appointments.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ);

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  return s;
}
async function convContact(id: string): Promise<string | null> {
  return (await query<{ contact_id: string | null }>(`SELECT contact_id FROM conversations WHERE id=$1`, [id])).rows[0].contact_id;
}
const resolve = (s: { tenantId: string }, clientId: string, channelUserId: string) =>
  resolveContactByIdentity({ tenantId: s.tenantId, clientId, channel: 'whatsapp', channelUserId, name: 'Test' });

test('a BOOKING that creates the contact auto-links the WhatsApp conversation, and it shows on the record', async () => {
  const s = await scenario();
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573058830676'); // raw wa_id, contact_id NULL
  assert.equal(await convContact(conv.id), null);

  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(10),
    channel: 'whatsapp', channelUserId: '+573058830676', customerName: 'Yerson', customerPhone: '+573058830676',
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: null, now: NOW,
  });
  assert.ok(r.ok, 'booking succeeds');
  if (!r.ok) throw new Error('unreachable');
  const cid = r.value.contact_id!;
  assert.equal(await convContact(conv.id), cid, 'conversation auto-linked to the booked contact');
  const convs = await listContactConversations(s.tenantId, cid, s.clientId);
  assert.ok(convs.some((c) => c.id === conv.id), 'the conversation now appears on the contact record');
});

test('raw ↔ E.164 match through the normalizer, both directions', async () => {
  const s = await scenario();
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  const rawConv = await getOrCreateConversation(s.tenantId, 'wf1', '573001110001'); // raw
  const { contact: cA } = await resolve(s, s.clientId, '+573001110001'); // E.164 identity
  assert.equal(await convContact(rawConv.id), cA.id, 'raw ref ↔ E.164 identity');

  const plusConv = await getOrCreateConversation(s.tenantId, 'wf1', '+573002220002'); // stored with a '+'
  const { contact: cB } = await resolve(s, s.clientId, '573002220002'); // raw identity
  assert.equal(await convContact(plusConv.id), cB.id, '+ref ↔ raw identity');
});

test('a conversation already linked to a DIFFERENT contact is NOT overwritten', async () => {
  const s = await scenario();
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573003330003'); // phone P
  const { contact: x } = await resolve(s, s.clientId, '+573009990000'); // a different person
  await linkConversationToContact(s.tenantId, conv.id, x.id); // deliberate (mis)link to X
  const { contact: a } = await resolve(s, s.clientId, '+573003330003'); // the real owner of P
  assert.notEqual(a.id, x.id);
  assert.equal(await convContact(conv.id), x.id, 'existing link preserved — never overwritten');
});

test('CROSS-CLIENT: the same phone links only within each client', async () => {
  const s = await scenario();
  await seedWorkflow(s.tenantId, s.clientId, 'wf-a');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf-b');
  const convA = await getOrCreateConversation(s.tenantId, 'wf-a', '573058830676'); // client A
  const convB = await getOrCreateConversation(s.tenantId, 'wf-b', '573058830676'); // client B, same phone

  const { contact: cA } = await resolve(s, s.clientId, '+573058830676');
  assert.equal(await convContact(convA.id), cA.id, 'linked within client A');
  assert.equal(await convContact(convB.id), null, 'NOT linked across to client B');

  const { contact: cB } = await resolve(s, s.otherClientId, '+573058830676');
  assert.equal(await convContact(convB.id), cB.id, 'linked within client B');
  assert.equal(await convContact(convA.id), cA.id, 'client A link unchanged');
  assert.notEqual(cA.id, cB.id, 'two distinct contacts, one per client');
});

test('backfill links a NULL conversation and is idempotent (run twice, same end state)', async () => {
  const s = await scenario();
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  const { contact: c } = await resolve(s, s.clientId, '+573004440004'); // contact first
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573004440004'); // NULL conv created AFTER
  assert.equal(await convContact(conv.id), null);

  await backfillConversationContacts();
  assert.equal(await convContact(conv.id), c.id, 'backfill linked the NULL conversation');
  await backfillConversationContacts();
  assert.equal(await convContact(conv.id), c.id, 'second run leaves it unchanged (idempotent)');
});

test('§4: passing workflowRef + conversationRef sets source_conversation_id (attribution)', async () => {
  const s = await scenario();
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  const r = await createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(12),
    channel: 'whatsapp', channelUserId: '+573007770001', customerPhone: '+573007770001',
    workflowRef: 'wf1', conversationRef: '573007770001', // the machine route feeds these from the header + body
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: null, now: NOW,
  });
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  assert.ok(r.value.source_conversation_id, 'source_conversation_id is set from the conversation_ref');
  assert.equal(await convContact(r.value.source_conversation_id!), r.value.contact_id, 'that conversation is linked to the booked contact');
});

test('a failing link inside a SAVEPOINT does NOT poison the caller transaction (booking-safe)', async () => {
  const s = await scenario();
  // Mirrors tryLinkConversationsByPhone: a failure inside the savepoint rolls back only the
  // link; the outer txn (the booking) still commits its own writes.
  const id = await withTransaction(async (client) => {
    await client.query('SAVEPOINT sp');
    try {
      await client.query('SELECT 1/0'); // the link "fails"
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT sp');
    }
    const r = await client.query<{ id: string }>(
      `INSERT INTO clients (tenant_id, name, is_default) VALUES ($1, 'after-savepoint', false) RETURNING id`,
      [s.tenantId],
    );
    return r.rows[0].id;
  });
  assert.equal((await query(`SELECT 1 FROM clients WHERE id=$1`, [id])).rowCount, 1, 'the outer write committed despite the failed link');
});
