import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setContactWhatsappUsername, listContacts, getContactById } from '../../src/db/repositories/contacts.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * JP-3 — the WhatsApp username is STORED + SEARCHABLE + CHANGE-TIMELINED, and is NEVER a match key
 * (two contacts can share one). Repo logic + listContacts search + the CRM upsert route.
 */
const tenants: string[] = [];
after(async () => { for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const events = (tenantId: string, contactId: string) =>
  query<{ event_type: string; detail: unknown }>(
    `SELECT event_type, detail FROM crm_activity_events WHERE tenant_id = $1 AND contact_id = $2 AND event_type = 'whatsapp_username_changed' ORDER BY occurred_at`,
    [tenantId, contactId],
  ).then((r) => r.rows);
const usernameOf = (tenantId: string, clientId: string, id: string) =>
  getContactById(tenantId, id, clientId).then((c) => c?.whatsapp_username ?? null);

test('first set stores it (no event); a DIFFERENT one updates + writes a change event; the same just refreshes', async () => {
  const s = await seedScenario({ enableCrm: true }); tenants.push(s.tenantId);
  const c = await seedContact(s.tenantId, s.clientId, { name: 'Nando' });

  // First time → stored, NO timeline event (it isn't a "change").
  const r1 = await setContactWhatsappUsername(s.tenantId, s.clientId, c, '@nanditho.66');
  assert.deepEqual([r1.changed, r1.to], [true, 'nanditho.66']);
  assert.equal(await usernameOf(s.tenantId, s.clientId, c), 'nanditho.66');
  assert.equal((await events(s.tenantId, c)).length, 0, 'first set is silent');

  // Same handle again → no change, no event (seen_at refreshed only).
  const rSame = await setContactWhatsappUsername(s.tenantId, s.clientId, c, 'nanditho.66');
  assert.equal(rSame.changed, false);
  assert.equal((await events(s.tenantId, c)).length, 0);

  // A different handle → updated + ONE change event with {from, to}.
  const r2 = await setContactWhatsappUsername(s.tenantId, s.clientId, c, 'nando.nuevo');
  assert.deepEqual([r2.changed, r2.from, r2.to], [true, 'nanditho.66', 'nando.nuevo']);
  assert.equal(await usernameOf(s.tenantId, s.clientId, c), 'nando.nuevo');
  const evs = await events(s.tenantId, c);
  assert.equal(evs.length, 1);
  assert.deepEqual(evs[0].detail, { from: 'nanditho.66', to: 'nando.nuevo' });
});

test('garbage is a no-op: sentinel, empty, and over-length never store', async () => {
  const s = await seedScenario({ enableCrm: true }); tenants.push(s.tenantId);
  const c = await seedContact(s.tenantId, s.clientId);
  for (const junk of ['undefined', '', '   ', '@', 'x'.repeat(65)]) {
    const r = await setContactWhatsappUsername(s.tenantId, s.clientId, c, junk);
    assert.equal(r.changed, false, `"${junk}" is rejected`);
  }
  assert.equal(await usernameOf(s.tenantId, s.clientId, c), null, 'nothing was stored');
});

test('the username is NEVER a match key: two contacts can share one and stay separate', async () => {
  const s = await seedScenario({ enableCrm: true }); tenants.push(s.tenantId);
  const a = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  const b = await seedContact(s.tenantId, s.clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  await setContactWhatsappUsername(s.tenantId, s.clientId, a, 'shared.handle');
  await setContactWhatsappUsername(s.tenantId, s.clientId, b, 'shared.handle');
  assert.notEqual(a, b);
  assert.equal(await usernameOf(s.tenantId, s.clientId, a), 'shared.handle');
  assert.equal(await usernameOf(s.tenantId, s.clientId, b), 'shared.handle');
  const both = await query<{ n: string }>(`SELECT count(*)::text n FROM contacts WHERE tenant_id = $1 AND whatsapp_username = 'shared.handle'`, [s.tenantId]);
  assert.equal(both.rows[0].n, '2', 'two distinct contacts, never merged');
});

test('the contacts list is searchable by username', async () => {
  const s = await seedScenario({ enableCrm: true }); tenants.push(s.tenantId);
  const c = await seedContact(s.tenantId, s.clientId, { name: 'Sin nombre util', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
  await setContactWhatsappUsername(s.tenantId, s.clientId, c, 'findme.123');
  const hits = await listContacts(s.tenantId, { clientId: s.clientId, search: 'findme.123' });
  assert.ok(hits.items.some((x) => x.id === c), 'search by username returns the contact');
  // A different username search does not.
  const miss = await listContacts(s.tenantId, { clientId: s.clientId, search: 'someone.else.9999' });
  assert.ok(!miss.items.some((x) => x.id === c));
});

test('the CRM upsert route accepts whatsapp_username and stores it on the resolved contact', async () => {
  const s = await seedScenario({ enableCrm: true }); tenants.push(s.tenantId);
  const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: true });
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['crm.read', 'crm.write']);
  const { POST: Upsert } = await import('../../web/app/api/crm/v1/contacts/upsert/route.js');

  const res = await Upsert(new Request('http://t/api/crm/v1/contacts/upsert', {
    method: 'POST',
    headers: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef, 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '+573120000221', name: 'Nando', whatsapp_username: '@nanditho.66' }),
  }));
  assert.equal(res.status, 200);
  const body = await res.json();
  const stored = await query<{ whatsapp_username: string | null }>(
    `SELECT whatsapp_username FROM contacts WHERE id = $1`, [body.contact.id],
  );
  assert.equal(stored.rows[0].whatsapp_username, 'nanditho.66', 'stored without the "@"');
});
