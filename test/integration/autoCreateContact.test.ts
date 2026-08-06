import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { ensureContactForInboundMessage, resolveContactByIdentity } from '../../src/db/repositories/contactIdentities.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { listContactConversations } from '../../src/db/repositories/contacts.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * D-2: a person who writes exists in the CRM immediately. ensureContactForInboundMessage is
 * the worker half of the hot endpoint's gated, fail-safe hook. Channel-blind (classifies the
 * ref by value), concurrency-safe, and never overwrites an existing link.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  await seedWorkflow(s.tenantId, s.otherClientId, 'wf2');
  return s;
}
const convContact = async (id: string): Promise<string | null> =>
  (await query<{ contact_id: string | null }>(`SELECT contact_id FROM conversations WHERE id=$1`, [id])).rows[0].contact_id;
const contactCount = async (tenantId: string, clientId: string): Promise<number> =>
  (await query<{ n: number }>(`SELECT count(*)::int n FROM contacts WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId])).rows[0].n;

test('first inbound from an unknown identity → one contact (name NULL, stage new, source=label), linked + on the record', async () => {
  const s = await scenario();
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573058830676');
  await ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, '573058830676', 'whatsapp');

  const cid = await convContact(conv.id);
  assert.ok(cid, 'conversation linked');
  assert.equal(await contactCount(s.tenantId, s.clientId), 1, 'exactly one contact created');
  const c = (await query<{ name: string | null; stage: string; channel: string }>(`SELECT name, stage, channel FROM contacts WHERE id=$1`, [cid])).rows[0];
  assert.equal(c.name, null, 'name NULL');
  assert.equal(c.stage, 'new', "stage 'new'");
  assert.equal(c.channel, 'whatsapp', 'source/channel = the label');
  const ident = (await query<{ kind: string; value: string; label: string | null }>(`SELECT kind, value, label FROM contact_identities WHERE contact_id=$1`, [cid])).rows;
  assert.deepEqual(ident, [{ kind: 'phone', value: '+573058830676', label: 'whatsapp' }], 'one phone identity, normalized, labeled');
  const convs = await listContactConversations(s.tenantId, cid!, s.clientId);
  assert.ok(convs.some((x) => x.id === conv.id), 'appears on the contact record timeline');
});

test('second message from the same person → no new contact, still linked', async () => {
  const s = await scenario();
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573001110001');
  await ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, '573001110001', 'whatsapp');
  const first = await convContact(conv.id);
  await ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, '573001110001', 'whatsapp');
  assert.equal(await convContact(conv.id), first, 'same contact, link unchanged');
  assert.equal(await contactCount(s.tenantId, s.clientId), 1, 'no second contact');
});

test('an identity that already belongs to a contact → links, does not create', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'booking', channelUserId: '+573002220002', name: 'Booked Person' });
  const before = await contactCount(s.tenantId, s.clientId);
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573002220002');
  await ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, '573002220002', 'whatsapp');
  assert.equal(await convContact(conv.id), contact.id, 'linked to the pre-existing contact');
  assert.equal(await contactCount(s.tenantId, s.clientId), before, 'no new contact created');
});

test('a non-phone conversation_ref (ig_...) → stored as kind external, collides with nothing', async () => {
  const s = await scenario();
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', 'ig_17841400000000000');
  await ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, 'ig_17841400000000000', 'instagram');
  const cid = await convContact(conv.id);
  const ident = (await query<{ kind: string; value: string }>(`SELECT kind, value FROM contact_identities WHERE contact_id=$1`, [cid])).rows;
  assert.deepEqual(ident, [{ kind: 'external', value: 'ig_17841400000000000' }], 'external identity, stored verbatim');
});

test('CROSS-CLIENT: the same conversation_ref in two clients yields two independent contacts', async () => {
  const s = await scenario();
  const convA = await getOrCreateConversation(s.tenantId, 'wf1', '573009990000'); // client A
  const convB = await getOrCreateConversation(s.tenantId, 'wf2', '573009990000'); // client B, same ref
  await ensureContactForInboundMessage(s.tenantId, s.clientId, convA.id, '573009990000', 'whatsapp');
  await ensureContactForInboundMessage(s.tenantId, s.otherClientId, convB.id, '573009990000', 'whatsapp');
  const a = await convContact(convA.id);
  const b = await convContact(convB.id);
  assert.ok(a && b && a !== b, 'two independent contacts, one per client');
  assert.equal(await contactCount(s.tenantId, s.clientId), 1);
  assert.equal(await contactCount(s.tenantId, s.otherClientId), 1);
});

test('two simultaneous first messages (Promise.all) → exactly one contact', async () => {
  const s = await scenario();
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', '573007770007');
  // Mirror the route's fail-safe: the concurrency loser may reject; that's caught + tolerated.
  await Promise.allSettled([
    ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, '573007770007', 'whatsapp'),
    ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, '573007770007', 'whatsapp'),
  ]);
  assert.equal(await contactCount(s.tenantId, s.clientId), 1, 'the UNIQUE identity index collapses the race to one contact');
  assert.ok(await convContact(conv.id), 'conversation linked');
});
