import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { resolveContactByIdentity, findContactIdsByIdentity } from '../../src/db/repositories/contactIdentities.js';
import { getContactById, updateContact, setContactConsent } from '../../src/db/repositories/contacts.js';
import { createFieldDefinition, listFieldDefinitions, validateCustomFieldValues, type FieldDefinition } from '../../src/db/repositories/clientFieldDefinitions.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * D-3: a bot enriches the contact D-2 created — fill-empty name/email, overwrite consent,
 * and a PARTIAL custom_fields update (never a destructive replace). All go through the C-2
 * identity spine, so the same person can't fork into two contacts.
 */
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
const cf = async (id: string): Promise<Record<string, unknown>> =>
  (await query<{ custom_fields: Record<string, unknown> }>(`SELECT custom_fields FROM contacts WHERE id=$1`, [id])).rows[0].custom_fields;

test('name is FILL-EMPTY: a nameless (D-2) contact gets a name; a later DIFFERENT name does NOT overwrite', async () => {
  const s = await scenario();
  const { contact: c0 } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573058830676' });
  assert.equal(c0.name, null, 'born nameless (D-2)');
  const { contact: c1 } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573058830676', name: 'Yerson' });
  assert.equal(c1.id, c0.id, 'same contact');
  assert.equal(c1.name, 'Yerson', 'the empty name was filled');
  const { contact: c2 } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573058830676', name: 'Someone Else' });
  assert.equal(c2.name, 'Yerson', 'a non-empty name is NEVER overwritten by a bot');
});

test('email is FILL-EMPTY and case/whitespace-normalized to ONE identity (no duplicate)', async () => {
  const s = await scenario();
  const { contact: a } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'api', channelUserId: 'Yerson@Example.com ', email: 'Yerson@Example.com ' });
  const { contact: b } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'api', channelUserId: '  yerson@example.com', email: '  yerson@example.com' });
  assert.equal(b.id, a.id, 'differently-cased/spaced email resolves to the SAME contact (normalize, never string-compare)');
  const emailIds = (await query<{ value: string }>(`SELECT value FROM contact_identities WHERE contact_id=$1 AND kind='email'`, [a.id])).rows.map((r) => r.value);
  assert.deepEqual(emailIds, ['yerson@example.com'], 'one email identity, stored normalized');
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, email: 'YERSON@EXAMPLE.COM' }), [a.id], 'found by any casing');
});

test('consent OVERWRITES and persists (an explicit opt-out sticks)', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'api', channelUserId: '+573001112222' });
  assert.equal(contact.messaging_consent, 'unknown', 'default is unknown');
  await setContactConsent(s.tenantId, s.clientId, contact.id, 'opted_out', 'api');
  assert.equal((await getContactById(s.tenantId, contact.id, s.clientId))!.messaging_consent, 'opted_out', 'overwritten to opted_out');
  await setContactConsent(s.tenantId, s.clientId, contact.id, 'opted_out', 'api');
  assert.equal((await getContactById(s.tenantId, contact.id, s.clientId))!.messaging_consent, 'opted_out', 'still opted_out — it persists');
});

test('custom_fields is PARTIAL: a second key preserves the first; "" clears just one; the rest survive', async () => {
  const s = await scenario();
  await createFieldDefinition({ tenantId: s.tenantId, clientId: s.clientId, key: 'color', label: 'Color', type: 'text' });
  await createFieldDefinition({ tenantId: s.tenantId, clientId: s.clientId, key: 'size', label: 'Size', type: 'text' });
  await createFieldDefinition({ tenantId: s.tenantId, clientId: s.clientId, key: 'age', label: 'Age', type: 'number' });
  const defs = await listFieldDefinitions(s.tenantId, s.clientId, { enabledOnly: true });
  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'api', channelUserId: '+573004445555' });

  const write = async (v: unknown) => {
    const c = validateCustomFieldValues(defs, v);
    if (!c.ok) throw new Error(c.error);
    await updateContact(s.tenantId, contact.id, { custom_fields: c.value, custom_fields_clear: c.clear }, s.clientId);
  };
  await write({ color: 'blue' });
  assert.deepEqual(await cf(contact.id), { color: 'blue' });
  await write({ size: 'M' });
  assert.deepEqual(await cf(contact.id), { color: 'blue', size: 'M' }, 'the first key SURVIVES a second write (no full-replace data loss)');
  await write({ age: 30 });
  assert.deepEqual(await cf(contact.id), { color: 'blue', size: 'M', age: 30 }, 'a number key merges too');
  await write({ color: '' });
  assert.deepEqual(await cf(contact.id), { size: 'M', age: 30 }, 'only the explicitly-emptied key is removed');
});

test('custom_fields validation: unknown key and wrong type each fail, naming the field; value/clear split is correct', () => {
  const defs: FieldDefinition[] = [
    { id: '1', tenant_id: 't', client_id: 'c', entity: 'contact', key: 'age', label: 'Age', type: 'number', options: null, position: 0, enabled: true },
  ];
  const unknown = validateCustomFieldValues(defs, { color: 'blue' });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /color/, 'unknown key error names it');
  const wrong = validateCustomFieldValues(defs, { age: 'not a number' });
  assert.equal(wrong.ok, false);
  if (!wrong.ok) assert.match(wrong.error, /age/, 'wrong-type error names the field');
  const good = validateCustomFieldValues(defs, { age: 42 });
  assert.ok(good.ok && good.value.age === 42 && good.clear.length === 0, 'a valid value → value set, nothing cleared');
  const cleared = validateCustomFieldValues(defs, { age: '' });
  assert.ok(cleared.ok && Object.keys(cleared.value).length === 0 && cleared.clear[0] === 'age', 'an emptied known key → clear, not set');
});

test('CROSS-CLIENT: an identity that exists only in another client does NOT resolve', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.otherClientId, channel: 'api', channelUserId: '+573009998888' });
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, phone: '+573009998888' }), [], 'invisible from the other client');
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.otherClientId, phone: '573009998888' }), [contact.id], 'visible only in its own client (raw ↔ E.164 normalized)');
});
