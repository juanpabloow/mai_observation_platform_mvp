import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  resolveContactByIdentity,
  findContactIdsByIdentity,
  listCandidatesForContact,
  classifyDeclaredIdentity,
} from '../../src/db/repositories/contactIdentities.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * I-1 MULTI-IDENTITY PUSH — a workflow declares EVERY identity it knows for one person in a
 * single `identities: [{kind, value, label}]` call, and the platform links them to ONE contact.
 *
 * These exercise the identity spine directly (the same chokepoint the messages push, the CRM
 * upsert, and appointment creation all funnel through). The point is the resolution RULES:
 * create-with-all, attach-missing, and — the careful one — DIFFERENT existing contacts must
 * never auto-merge (record a candidate, resolve to the oldest, mutate nothing).
 */
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  return s;
}

const identitiesOf = async (contactId: string): Promise<string[]> =>
  (await query<{ value: string }>(`SELECT value FROM contact_identities WHERE contact_id=$1`, [contactId])).rows
    .map((r) => r.value)
    .sort();
const contactCount = async (tenantId: string, clientId: string): Promise<number> =>
  Number((await query<{ n: string }>(`SELECT count(*) n FROM contacts WHERE tenant_id=$1 AND client_id=$2`, [tenantId, clientId])).rows[0].n);

// ── The pure declared-identity classifier (external is honored VERBATIM) ─────────────
test('classifyDeclaredIdentity honors the declared kind — an all-digits `external` is NEVER re-read as a phone', () => {
  // The whole reason the WhatsApp phone (wa_id) and an opaque user id can coexist: a value
  // that classifyIdentity() would call a phone stays `external` when the workflow declares it.
  assert.deepEqual(classifyDeclaredIdentity('external', '1234567890'), { kind: 'external', value: '1234567890' });
  assert.deepEqual(classifyDeclaredIdentity('external', 'wamid.HBgLOPAQUE'), { kind: 'external', value: 'wamid.HBgLOPAQUE' });
  // phone/email are still normalized; a value invalid for its declared kind is dropped (null),
  // so one bad identity in the array never fails the write.
  assert.deepEqual(classifyDeclaredIdentity('phone', '573058830676'), { kind: 'phone', value: '+573058830676' });
  assert.deepEqual(classifyDeclaredIdentity('email', 'FOO@Bar.com '), { kind: 'email', value: 'foo@bar.com' });
  assert.equal(classifyDeclaredIdentity('phone', 'not-a-phone'), null);
  assert.equal(classifyDeclaredIdentity('email', 'nope'), null);
  assert.equal(classifyDeclaredIdentity('external', '   '), null);
});

// ── Rule 1: none exist → ONE contact carrying all ────────────────────────────────────
test('two brand-new identities in one call → ONE contact with both; a later push of just the second resolves to it', async () => {
  const s = await scenario();
  // The motivating case: a conversation on an opaque WhatsApp user id, plus the declared phone.
  const { contact: c1, candidatesRecorded } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: 'wamid.OPAQUE1',
    identities: [{ kind: 'phone', value: '+573001234567', label: 'wa_phone' }],
  });
  assert.equal(candidatesRecorded, 0);
  assert.deepEqual(await identitiesOf(c1.id), ['+573001234567', 'wamid.OPAQUE1']);
  assert.equal(await contactCount(s.tenantId, s.clientId), 1);

  // Later, only the phone is known (a typed booking, say) → the SAME person, not a second.
  const { contact: again } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'booking', channelUserId: '+573001234567',
  });
  assert.equal(again.id, c1.id, 'the second identity alone resolves back to the one contact');
  assert.equal(await contactCount(s.tenantId, s.clientId), 1, 'still exactly one person');
});

// ── Rule 2: all resolve to the SAME contact → attach the missing one ─────────────────
test('one existing identity + one new → the new identity is attached to the existing contact', async () => {
  const s = await scenario();
  const { contact: existing } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573007654321',
  });
  const { contact: resolved, candidatesRecorded } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: '+573007654321',
    identities: [{ kind: 'email', value: 'known@mail.com', label: 'from_profile' }],
  });
  assert.equal(resolved.id, existing.id);
  assert.equal(candidatesRecorded, 0);
  assert.deepEqual(await identitiesOf(existing.id), ['+573007654321', 'known@mail.com']);
  assert.equal(await contactCount(s.tenantId, s.clientId), 1);
});

// ── Rule 3: DIFFERENT existing contacts → record a candidate, oldest wins, MUTATE NOTHING ──
test('identities that span TWO existing contacts → candidate recorded (both directions), nothing merged, oldest resolves, both keep their data', async () => {
  const s = await scenario();
  const { contact: older } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573001112233',
  });
  await query(`UPDATE contacts SET created_at = now() - interval '10 days' WHERE id=$1`, [older.id]);
  const { contact: newer } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'api', channelUserId: 'newer@mail.com', email: 'newer@mail.com',
  });
  assert.notEqual(newer.id, older.id, 'two separate people to begin with');

  // A push that declares BOTH their identities AND a third, brand-new one.
  const { contact: winner, candidatesRecorded } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: '+573001112233',
    identities: [
      { kind: 'email', value: 'newer@mail.com', label: 'wa' },
      { kind: 'external', value: 'BRAND_NEW_XYZ', label: 'wa' },
    ],
  });

  assert.equal(winner.id, older.id, 'resolves DETERMINISTICALLY to the oldest');
  assert.equal(candidatesRecorded, 1, 'the collision is flagged, never auto-merged');

  // MUTATE NOTHING: neither original gained or lost an identity...
  assert.deepEqual(await identitiesOf(older.id), ['+573001112233'], 'older keeps exactly its own data');
  assert.deepEqual(await identitiesOf(newer.id), ['newer@mail.com'], 'newer keeps exactly its own data');
  // ...and the brand-new identity was attached to NOBODY (no silent creation/attachment).
  assert.deepEqual(
    await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: 'BRAND_NEW_XYZ' }),
    [],
    'the third, new identity is not attached anywhere',
  );
  assert.equal(await contactCount(s.tenantId, s.clientId), 2, 'still exactly two people');

  // "Both directions" is satisfied by the symmetric candidate query — one row surfaces on BOTH.
  assert.equal((await listCandidatesForContact(s.tenantId, s.clientId, older.id)).length, 1, 'visible from the older contact');
  assert.equal((await listCandidatesForContact(s.tenantId, s.clientId, newer.id)).length, 1, 'visible from the newer contact');
});

// ── Rule 4: an opaque `external` id coexists with a phone on one contact ──────────────
test('a declared `external` opaque id lives alongside a phone identity on ONE contact, with its own label', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: '+573009998877',
    identities: [{ kind: 'external', value: 'wamid.HBgL_OPAQUE_USER', label: 'wa_user_id' }],
  });
  const rows = (
    await query<{ kind: string; value: string; label: string | null }>(
      `SELECT kind, value, label FROM contact_identities WHERE contact_id=$1 ORDER BY kind`,
      [contact.id],
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => `${r.kind}:${r.value}`),
    ['external:wamid.HBgL_OPAQUE_USER', 'phone:+573009998877'],
    'both a phone and an opaque external id on the one contact',
  );
  assert.equal(rows.find((r) => r.kind === 'external')?.label, 'wa_user_id', 'the per-identity label is preserved');
});

// ── Rule 5: absent `identities` → byte-identical to today ─────────────────────────────
test('omitting `identities` behaves exactly as before — one identity, no candidates', async () => {
  const s = await scenario();
  const { contact, candidatesRecorded } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573001010101',
  });
  assert.equal(candidatesRecorded, 0);
  assert.deepEqual(await identitiesOf(contact.id), ['+573001010101']);
  assert.equal(await contactCount(s.tenantId, s.clientId), 1);
});

// ── Cross-client isolation: the SAME identity values are independent per client ───────
test('the same declared identities in two clients resolve to SEPARATE contacts (strict tenant+client scope)', async () => {
  const s = await scenario();
  const call = (clientId: string) =>
    resolveContactByIdentity({
      tenantId: s.tenantId,
      clientId,
      channel: 'whatsapp',
      channelUserId: 'shared@mail.com',
      identities: [{ kind: 'phone', value: '+573002020202', label: 'wa' }],
    });
  const { contact: a, candidatesRecorded: ca } = await call(s.clientId);
  const { contact: b, candidatesRecorded: cb } = await call(s.otherClientId);

  assert.notEqual(a.id, b.id, 'one contact per client — an identity in client A is invisible to client B');
  assert.equal(ca, 0);
  assert.equal(cb, 0, 'no cross-client collision');
  assert.deepEqual(await identitiesOf(a.id), ['+573002020202', 'shared@mail.com']);
  assert.deepEqual(await identitiesOf(b.id), ['+573002020202', 'shared@mail.com']);
  assert.equal(await contactCount(s.tenantId, s.clientId), 1);
  assert.equal(await contactCount(s.tenantId, s.otherClientId), 1);
});
