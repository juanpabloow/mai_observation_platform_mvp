import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import {
  classifyIdentity,
  resolveContactByIdentity,
  mergeContacts,
  listIdentitiesForContact,
} from '../../src/db/repositories/contactIdentities.js';
import { getOrCreateConversation, insertMessage } from '../../src/db/repositories/handoff.js';
import { detectCollapsedIdentity, applyContainment } from '../../src/db/repositories/identityContainment.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';

after(closeDb);

const bearer = (raw: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${raw}`, ...extra });

async function fullToken(s: Awaited<ReturnType<typeof seedScenario>>) {
  const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, [
    'handoff', 'handoff.context.read', 'crm.read', 'crm.write', 'scheduling.read', 'scheduling.write',
  ]);
  return { wfRef, rawToken };
}

test('ID-H §1: every entry point refuses a sentinel with a 422 and writes nothing', async () => {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  try {
    await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
    const { wfRef, rawToken } = await fullToken(s);
    const { POST: Messages } = await import('../../web/app/api/handoff/v1/messages/route.js');
    const { GET: Context } = await import('../../web/app/api/handoff/v1/context/route.js');
    const { POST: Upsert } = await import('../../web/app/api/crm/v1/contacts/upsert/route.js');
    const { GET: Lookup } = await import('../../web/app/api/crm/v1/contacts/lookup/route.js');
    const { POST: CreateAppt } = await import('../../web/app/api/scheduling/v1/appointments/route.js');

    // messages: sentinel conversation_ref → 422, no conversation created.
    const m = await Messages(new Request('http://t/api/handoff/v1/messages', {
      method: 'POST', headers: bearer(rawToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ workflow_ref: wfRef, conversation_ref: 'undefined', sender: 'user', text: 'hola' }),
    }));
    assert.equal(m.status, 422);
    assert.equal((await m.json()).error.code, 'invalid_conversation_ref');

    // messages: sentinel identity value (passes the schema's min(1), fails our guard) → 422.
    const mi = await Messages(new Request('http://t/api/handoff/v1/messages', {
      method: 'POST', headers: bearer(rawToken, { 'content-type': 'application/json' }),
      body: JSON.stringify({ workflow_ref: wfRef, conversation_ref: '573001112233', sender: 'user', text: 'hola', identities: [{ kind: 'external', value: 'undefined' }] }),
    }));
    assert.equal(mi.status, 422);
    assert.equal((await mi.json()).error.code, 'invalid_identity');
    assert.equal((await query('SELECT count(*)::int n FROM conversations WHERE tenant_id=$1', [s.tenantId])).rows[0].n, 0, 'no conversation written');

    // crm upsert: sentinel phone → 422, no contact created.
    const u = await Upsert(new Request('http://t/api/crm/v1/contacts/upsert', {
      method: 'POST', headers: bearer(rawToken, { 'x-workflow-ref': wfRef, 'content-type': 'application/json' }),
      body: JSON.stringify({ phone: 'undefined' }),
    }));
    assert.equal(u.status, 422);
    assert.equal((await u.json()).error.code, 'invalid_identity');
    assert.equal((await query('SELECT count(*)::int n FROM contacts WHERE tenant_id=$1', [s.tenantId])).rows[0].n, 0, 'no contact written');

    // crm lookup: sentinel external_id → 422.
    const l = await Lookup(new Request('http://t/api/crm/v1/contacts/lookup?external_id=undefined', { headers: bearer(rawToken, { 'x-workflow-ref': wfRef }) }));
    assert.equal(l.status, 422);
    assert.equal((await l.json()).error.code, 'invalid_identity');

    // scheduling create: sentinel customer_phone → 422, no appointment.
    const a = await CreateAppt(new Request('http://t/api/scheduling/v1/appointments', {
      method: 'POST', headers: bearer(rawToken, { 'x-workflow-ref': wfRef, 'content-type': 'application/json', 'idempotency-key': randomUUID() }),
      body: JSON.stringify({ site_id: s.siteId, service_id: s.serviceHaircut, start_at: '2026-11-02T14:00:00.000Z', customer_phone: 'undefined' }),
    }));
    assert.equal(a.status, 422);
    assert.equal((await a.json()).error.code, 'invalid_identity');
    assert.equal((await query('SELECT count(*)::int n FROM appointments WHERE tenant_id=$1', [s.tenantId])).rows[0].n, 0, 'no appointment written');

    // context: sentinel conversation_ref → 422 (before any history read).
    const c = await Context(new Request(`http://t/api/handoff/v1/context?workflow_ref=${wfRef}&conversation_ref=undefined&through_message_id=${randomUUID()}`, { headers: bearer(rawToken) }));
    assert.equal(c.status, 422);
    assert.equal((await c.json()).error.code, 'invalid_conversation_ref');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ID-H §2: ENT-variant BSUID classifies as external, never a phone', async () => {
  assert.deepEqual(classifyIdentity('US.ENT.11815799212886844830'), { kind: 'external', value: 'US.ENT.11815799212886844830' });
  assert.deepEqual(classifyIdentity('CO.2405123456'), { kind: 'external', value: 'CO.2405123456' });
  assert.equal(classifyIdentity('undefined'), null, 'sentinel → null');
  assert.deepEqual(classifyIdentity('573001234567'), { kind: 'phone', value: '+573001234567' }, 'a real phone is still a phone');
});

test('ID-H §1: a quarantined conversation returns no context even with a valid anchor', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
    const { wfRef, rawToken } = await fullToken(s);
    const conv = await getOrCreateConversation(s.tenantId, wfRef, '573009998877');
    const { message } = await insertMessage({ tenantId: s.tenantId, conversationId: conv.id, sender: 'user', text: 'hola', contentType: 'text', contentDetail: null, externalMessageId: null, status: 'received', occurredAt: new Date(), metadata: null });
    // Simulate §4 quarantine (re-key the ref to an unmatchable value).
    const qref = `quarantined:${randomUUID()}`;
    await query('UPDATE conversations SET conversation_ref=$2 WHERE id=$1', [conv.id, qref]);
    const { GET: Context } = await import('../../web/app/api/handoff/v1/context/route.js');
    const res = await Context(new Request(`http://t/api/handoff/v1/context?workflow_ref=${wfRef}&conversation_ref=${encodeURIComponent(qref)}&through_message_id=${message.id}`, { headers: bearer(rawToken) }));
    assert.equal(res.status, 404, 'quarantined conversation is not readable even with a valid anchor');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ID-H §3: merge preserves every child row, applies most-restrictive consent, writes the event', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const keep = await seedContact(s.tenantId, s.clientId, { name: 'Keep', channelUserId: 'wa:keep' });
    const drop = await seedContact(s.tenantId, s.clientId, { name: 'Drop', channelUserId: 'wa:drop' });
    // Child rows on the DROP contact (these used to CASCADE-delete and be lost).
    await query(`INSERT INTO contact_notes (tenant_id, client_id, contact_id, body) VALUES ($1,$2,$3,'a note')`, [s.tenantId, s.clientId, drop]);
    await query(`INSERT INTO crm_tasks (tenant_id, client_id, contact_id, title) VALUES ($1,$2,$3,'a task')`, [s.tenantId, s.clientId, drop]);
    const tag = (await query<{ id: string }>(`INSERT INTO contact_tags (tenant_id, client_id, name) VALUES ($1,$2,'VIP') RETURNING id`, [s.tenantId, s.clientId])).rows[0].id;
    await query(`INSERT INTO contact_tag_links (tenant_id, client_id, contact_id, tag_id) VALUES ($1,$2,$3,$4)`, [s.tenantId, s.clientId, drop, tag]);
    // Consent: drop is MORE restrictive; custom fields on drop only.
    await query(`UPDATE contacts SET messaging_consent='opted_out', do_not_contact=true, custom_fields='{"barber":"Ana"}'::jsonb WHERE id=$1`, [drop]);
    await query(`UPDATE contacts SET messaging_consent='opted_in', do_not_contact=false WHERE id=$1`, [keep]);

    const childCount = async (tbl: string) => (await query<{ n: number }>(`SELECT count(*)::int n FROM ${tbl} WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.clientId])).rows[0].n;
    const before = { notes: await childCount('contact_notes'), tasks: await childCount('crm_tasks'), links: await childCount('contact_tag_links') };

    const result = await mergeContacts(s.tenantId, s.clientId, keep, drop, null);
    assert.equal(result.ok, true);

    // Nothing lost: the client-wide child counts are identical before and after.
    assert.deepEqual({ notes: await childCount('contact_notes'), tasks: await childCount('crm_tasks'), links: await childCount('contact_tag_links') }, before, 'no child row deleted');
    // All moved to the survivor.
    const onKeep = async (tbl: string) => (await query<{ n: number }>(`SELECT count(*)::int n FROM ${tbl} WHERE contact_id=$1`, [keep])).rows[0].n;
    assert.equal(await onKeep('contact_notes'), 1);
    assert.equal(await onKeep('crm_tasks'), 1);
    assert.equal(await onKeep('contact_tag_links'), 1);
    assert.equal((await query('SELECT count(*)::int n FROM contacts WHERE id=$1', [drop])).rows[0].n, 0, 'drop contact deleted');

    const survivor = (await query<{ messaging_consent: string; do_not_contact: boolean; custom_fields: Record<string, unknown> }>(
      'SELECT messaging_consent, do_not_contact, custom_fields FROM contacts WHERE id=$1', [keep])).rows[0];
    assert.equal(survivor.messaging_consent, 'opted_out', 'most-restrictive consent wins');
    assert.equal(survivor.do_not_contact, true, 'do_not_contact true wins');
    assert.equal(survivor.custom_fields.barber, 'Ana', 'survivor fills empty custom field from loser');

    const ev = await query('SELECT count(*)::int n FROM crm_activity_events WHERE contact_id=$1 AND event_type=$2', [keep, 'contact_merged']);
    assert.equal(ev.rows[0].n, 1, 'a contact_merged timeline event is written');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ID-H §4: containment detects a collapse, dry-run writes nothing, apply quarantines, re-detect is clean', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    // Seed a legacy collapse directly (the §1 guards would now refuse to create it).
    const sentinelContact = await seedContact(s.tenantId, s.clientId, { name: 'Collapsed', channelUserId: 'undefined' });
    await query(`INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value) VALUES ($1,$2,$3,'external','undefined')`, [s.tenantId, s.clientId, sentinelContact]);
    const wfId = `wf-${s.tenantId.slice(0, 8)}`;
    await query(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id) VALUES ($1,$2,'undefined',$3)`, [s.tenantId, wfId, sentinelContact]);

    // DETECT (read-only) — dry run must not change anything.
    const report = await detectCollapsedIdentity({ tenantId: s.tenantId });
    assert.ok(report.conversations.length >= 1, 'sentinel conversation detected');
    assert.ok(report.contacts.length >= 1, 'sentinel contact detected');
    assert.equal((await query(`SELECT conversation_ref FROM conversations WHERE tenant_id=$1`, [s.tenantId])).rows[0].conversation_ref, 'undefined', 'dry run changed nothing');

    // APPLY.
    const applied = await applyContainment(report);
    assert.ok(applied.quarantinedConversations >= 1 && applied.detachedContacts >= 1);
    const conv = (await query<{ conversation_ref: string; contact_id: string | null }>(`SELECT conversation_ref, contact_id FROM conversations WHERE tenant_id=$1`, [s.tenantId])).rows[0];
    assert.ok(conv.conversation_ref.startsWith('quarantined:'), 'conversation re-keyed');
    assert.equal(conv.contact_id, null, 'conversation detached from the shared contact');
    assert.equal((await query(`SELECT count(*)::int n FROM contact_identities WHERE contact_id=$1 AND value='undefined'`, [sentinelContact])).rows[0].n, 0, 'sentinel identity removed');

    // Idempotent: a re-detect finds nothing.
    const again = await detectCollapsedIdentity({ tenantId: s.tenantId });
    assert.equal(again.conversations.length, 0);
    assert.equal(again.contacts.length, 0);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('ID-H non-regression: a phone + BSUID push links ONE contact carrying both identities', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const { contact } = await resolveContactByIdentity({
      tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp',
      channelUserId: '573001234567', identities: [{ kind: 'external', value: 'CO.2405123456', label: 'whatsapp_bsuid' }],
    });
    const idents = await listIdentitiesForContact(s.tenantId, s.clientId, contact.id);
    const kinds = idents.map((i) => `${i.kind}:${i.value}`).sort();
    assert.ok(kinds.includes('phone:+573001234567'), 'phone identity attached');
    assert.ok(kinds.includes('external:CO.2405123456'), 'BSUID attached as external');
    assert.equal((await query('SELECT count(*)::int n FROM contacts WHERE tenant_id=$1 AND client_id=$2', [s.tenantId, s.clientId])).rows[0].n, 1, 'exactly one contact');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
