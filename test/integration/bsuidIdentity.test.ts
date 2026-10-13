import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import {
  backfillConversationContacts,
  classifyDeclaredIdentity,
  classifyIdentity,
  ensureContactForInboundMessage,
  findContactIdsByIdentity,
  findContactMatchesByIdentity,
  legacyBsuidPhone,
  linkNullConversationsByPhone,
  resolveContactByIdentity,
} from '../../src/db/repositories/contactIdentities.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';
import { r0ClassifyIdentity, r0NormalizeE164 } from '../support/r0Identity.js';

/**
 * WhatsApp BSUID ("CO.…") identity — the ONE self-contained change that the contingency
 * image (fix/bsuid-identity-contingency) carries on its own, so this file is identical in
 * both branches. A BSUID is an opaque `external` identity, never a phone; contacts created
 * by the OLD code (invented phone "+<digits>") are still found by a read-only
 * compatibility; NO path ever writes a phone derived from a BSUID. Synthetic data only.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function scenario() {
  const s = await seedScenario({});
  tenants.push(s.tenantId);
  return s;
}

// ── Identity: a BSUID stays an opaque id, never an invented phone ──────────────

test('a contact arriving by BSUID gets an external identity and no phone', async () => {
  const s = await scenario();
  const bsuid = `CO.${Date.now().toString().slice(-10)}`; // synthetic, digits only after the prefix
  assert.deepEqual(classifyIdentity(bsuid), { kind: 'external', value: bsuid });
  assert.equal(classifyDeclaredIdentity('phone', bsuid), null, 'declared as a phone, refused');
  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: bsuid, name: 'Cliente BSUID' });
  assert.equal(contact.phone_e164, null, 'no phone is invented from the BSUID digits');
  const ids = await query<{ kind: string; value: string }>(`SELECT kind, value FROM contact_identities WHERE contact_id = $1 ORDER BY kind`, [contact.id]);
  assert.deepEqual(ids.rows, [{ kind: 'external', value: bsuid }]);
  // The same BSUID again resolves to the SAME contact (no duplicate).
  const again = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: bsuid });
  assert.equal(again.contact.id, contact.id);
});

// ── BSUID compatibility: contacts created BEFORE the fix (legacy invented phone) ──────

/** A contact exactly as the OLD code stored it: channel_user_id = BSUID, phone = "+digits". */
async function seedLegacyBsuidContact(tenantId: string, clientId: string, bsuid: string, createdAt = "now() - interval '1 day'") {
  const phone = legacyBsuidPhone(bsuid)!;
  const c = await query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, client_id, name, phone_e164, channel, channel_user_id, created_at)
     VALUES ($1,$2,'Cliente legado',$3,'whatsapp',$4, ${createdAt}) RETURNING id`,
    [tenantId, clientId, phone, bsuid],
  );
  await query(
    `INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value, label) VALUES ($1,$2,$3,'phone',$4,'whatsapp')`,
    [tenantId, clientId, c.rows[0].id, phone],
  );
  return c.rows[0].id;
}

const syntheticBsuid = () => `CO.57${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`;

test('legacyBsuidPhone reproduces only what the old normalizer derived from a BSUID', () => {
  assert.equal(legacyBsuidPhone('CO.5730011122334'), '+5730011122334');
  assert.equal(legacyBsuidPhone(' CO.5730011122334 '), '+5730011122334');
  // The old code stripped EVERY non-digit, letters after the dot included.
  assert.equal(legacyBsuidPhone('CO.57300a1112233'), '+573001112233');
  for (const v of ['+573001112233', '573001112233', 'wa:573001112233', 'CO.', 'CO.0123456789', 'CO.12345', 'COL.573001112233', 'CO.57-3001112233', null, undefined, '']) {
    assert.equal(legacyBsuidPhone(v as string), null, String(v));
  }
});

test('a legacy BSUID contact is found again by its BSUID — no split, no new invented phone', async () => {
  const s = await scenario();
  const bsuid = syntheticBsuid();
  const legacyId = await seedLegacyBsuidContact(s.tenantId, s.clientId, bsuid);

  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: bsuid }), [legacyId], 'the bot lookup finds it');
  const before = await query(`SELECT 1 FROM contact_identities WHERE contact_id = $1`, [legacyId]);
  assert.equal(before.rowCount, 1, 'the lookup is read-only');

  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: bsuid });
  assert.equal(contact.id, legacyId, 'the inbound message resolves to the existing contact');
  const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND client_id = $2`, [s.tenantId, s.clientId]);
  assert.equal(n.rows[0].n, 1, 'no second contact');
  const ids = await query<{ kind: string; value: string }>(`SELECT kind, value FROM contact_identities WHERE contact_id = $1 ORDER BY kind`, [legacyId]);
  assert.deepEqual(ids.rows, [
    { kind: 'external', value: bsuid },
    { kind: 'phone', value: legacyBsuidPhone(bsuid) },
  ], 'the BSUID is learned; the legacy phone is NOT repaired or removed here');

  // From now on it matches directly by the external identity.
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: bsuid }), [legacyId]);
});

test('the compatibility never matches a real phone owner, another tenant, or a contact without the legacy phone', async () => {
  const s = await scenario();
  const bsuid = syntheticBsuid();
  const digitsPhone = legacyBsuidPhone(bsuid)!;

  // A REAL customer whose phone equals the BSUID digits (different channel_user_id).
  const real = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: digitsPhone, phone: digitsPhone, name: 'Teléfono real' });
  assert.equal(real.contact.phone_e164, digitsPhone);
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: bsuid }), [], 'not the phone owner');
  const fromBsuid = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: bsuid });
  assert.notEqual(fromBsuid.contact.id, real.contact.id, 'a BSUID never resolves to whoever owns those digits as a phone');
  assert.equal(fromBsuid.contact.phone_e164, null);

  // Another tenant with a legacy contact of the same BSUID sees only its own.
  const other = await scenario();
  const bsuid2 = syntheticBsuid();
  const otherLegacy = await seedLegacyBsuidContact(other.tenantId, other.clientId, bsuid2);
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: bsuid2 }), []);
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: other.tenantId, clientId: other.clientId, channelUserId: bsuid2 }), [otherLegacy]);

  // A BSUID with no legacy phone row of its own: nothing to recover (the old code always
  // wrote one), so a contact that only shares channel_user_id is not adopted by guess.
  const bsuid3 = syntheticBsuid();
  await query(
    `INSERT INTO contacts (tenant_id, client_id, name, channel, channel_user_id) VALUES ($1,$2,'Sin identidad','whatsapp',$3)`,
    [s.tenantId, s.clientId, bsuid3],
  );
  assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: bsuid3 }), []);
});

test('BSUID conversations link only by the exact external identity, never by stripped digits', async () => {
  const s = await scenario();
  const bsuid = syntheticBsuid();
  const digitsPhone = legacyBsuidPhone(bsuid)!;
  const wf = `wf-${randomUUID().slice(0, 6)}`;
  await seedWorkflow(s.tenantId, s.clientId, wf);
  const conv = await getOrCreateConversation(s.tenantId, wf, bsuid);
  assert.equal(conv.contact_id, null);

  // The real owner of those digits as a phone must NOT get the BSUID conversation.
  const real = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: digitsPhone });
  await linkNullConversationsByPhone(s.tenantId, s.clientId, real.contact.id);
  const after1 = await query<{ contact_id: string | null }>(`SELECT contact_id FROM conversations WHERE id = $1`, [conv.id]);
  assert.equal(after1.rows[0].contact_id, null, 'stripping CO. would have linked it to the wrong person');

  // The BSUID contact gets it.
  const bsuidContact = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: bsuid });
  const after2 = await query<{ contact_id: string | null }>(`SELECT contact_id FROM conversations WHERE id = $1`, [conv.id]);
  assert.equal(after2.rows[0].contact_id, bsuidContact.contact.id);
});

// ── E-5 backfill: a BSUID conversation links by its exact external identity ────────

/** Seeded directly (not via resolve, which would auto-link) so the BACKFILL does the work. */
async function seedContactWithIdentity(tenantId: string, clientId: string, kind: 'phone' | 'external', value: string, channelUserId = value) {
  const c = await query<{ id: string }>(
    `INSERT INTO contacts (tenant_id, client_id, name, phone_e164, channel, channel_user_id)
     VALUES ($1,$2,'Sembrado',$3,'whatsapp',$4) RETURNING id`,
    [tenantId, clientId, kind === 'phone' ? value : null, channelUserId],
  );
  await query(
    `INSERT INTO contact_identities (tenant_id, client_id, contact_id, kind, value, label) VALUES ($1,$2,$3,$4,$5,'whatsapp')`,
    [tenantId, clientId, c.rows[0].id, kind, value],
  );
  return c.rows[0].id;
}
async function nullConversation(tenantId: string, clientId: string, ref: string) {
  const wf = `wf-${randomUUID().slice(0, 6)}`;
  await seedWorkflow(tenantId, clientId, wf);
  const conv = await getOrCreateConversation(tenantId, wf, ref);
  assert.equal(conv.contact_id, null);
  return conv.id;
}
const linkedTo = async (convId: string) =>
  (await query<{ contact_id: string | null }>(`SELECT contact_id FROM conversations WHERE id = $1`, [convId])).rows[0].contact_id;

test('backfill never links a BSUID conversation to the owner of its digits as a phone', async () => {
  const s = await scenario();
  const bsuid = syntheticBsuid();
  const conv = await nullConversation(s.tenantId, s.clientId, bsuid);
  const realOwner = await seedContactWithIdentity(s.tenantId, s.clientId, 'phone', legacyBsuidPhone(bsuid)!, legacyBsuidPhone(bsuid)!);
  // The same real person also has a conversation by phone — that one MUST still link.
  const phoneConv = await nullConversation(s.tenantId, s.clientId, legacyBsuidPhone(bsuid)!.slice(1));

  await backfillConversationContacts();
  assert.equal(await linkedTo(conv), null, 'the BSUID conversation is not the phone owner');
  assert.equal(await linkedTo(phoneConv), realOwner, 'the phone conversation links as before');

  // Once the BSUID's own contact exists (external identity), the backfill links it there.
  const bsuidContact = await seedContactWithIdentity(s.tenantId, s.clientId, 'external', bsuid);
  await backfillConversationContacts();
  assert.equal(await linkedTo(conv), bsuidContact);
  assert.equal(await linkedTo(phoneConv), realOwner);

  // Repeated runs: same end state, nothing re-pointed.
  const snapshot = async () => (await query(`SELECT id, contact_id FROM conversations WHERE tenant_id = $1 ORDER BY id`, [s.tenantId])).rows;
  const before = await snapshot();
  await backfillConversationContacts();
  await backfillConversationContacts();
  assert.deepEqual(await snapshot(), before, 'idempotent');
});

test('backfill keeps a BSUID conversation inside its own client and tenant', async () => {
  const s = await scenario();
  const bsuid = syntheticBsuid();
  const conv = await nullConversation(s.tenantId, s.clientId, bsuid); // workflow of client A
  // Exactly the same BSUID held by a contact of ANOTHER client of the tenant, and of another tenant.
  const otherClientContact = await seedContactWithIdentity(s.tenantId, s.otherClientId, 'external', bsuid);
  const other = await scenario();
  const otherTenantContact = await seedContactWithIdentity(other.tenantId, other.clientId, 'external', bsuid);
  const otherTenantConv = await nullConversation(other.tenantId, other.clientId, bsuid);

  await backfillConversationContacts();
  assert.equal(await linkedTo(conv), null, 'not across clients, not across tenants');
  assert.equal(await linkedTo(otherTenantConv), otherTenantContact, 'each tenant links only its own');
  assert.notEqual(otherClientContact, otherTenantContact);
});

test('backfill: a legacy BSUID contact is recovered; a legacy + new split is ambiguous and left alone', async () => {
  const s = await scenario();
  // Legacy only (the old code's row: invented phone + channel_user_id = BSUID) → linked to it.
  const legacyOnly = syntheticBsuid();
  const legacyConv = await nullConversation(s.tenantId, s.clientId, legacyOnly);
  const legacyContact = await seedLegacyBsuidContact(s.tenantId, s.clientId, legacyOnly);

  // Split: a legacy contact AND a new contact holding the BSUID as external → ambiguous.
  const split = syntheticBsuid();
  const splitConv = await nullConversation(s.tenantId, s.clientId, split);
  await seedLegacyBsuidContact(s.tenantId, s.clientId, split);
  await seedContactWithIdentity(s.tenantId, s.clientId, 'external', split);

  const r1 = await backfillConversationContacts();
  assert.equal(await linkedTo(legacyConv), legacyContact, 'compatibility: the contact the BSUID created');
  assert.equal(await linkedTo(splitConv), null, 'two candidates: never guessed');
  assert.ok(r1.ambiguous >= 1, 'reported as ambiguous');

  const r2 = await backfillConversationContacts();
  assert.equal(await linkedTo(splitConv), null, 'still ambiguous on a re-run');
  assert.ok(r2.ambiguous >= 1);
  assert.equal(await linkedTo(legacyConv), legacyContact);
});

test('refs that merely contain letters keep their documented phone reading ("wa:573…")', async () => {
  const s = await scenario();
  const phone = `+5730${String(Date.now()).slice(-8)}`;
  const conv = await nullConversation(s.tenantId, s.clientId, `wa:${phone.slice(1)}`);
  const owner = await seedContactWithIdentity(s.tenantId, s.clientId, 'phone', phone, phone.slice(1));
  await backfillConversationContacts();
  assert.equal(await linkedTo(conv), owner, 'the n8n contract example still links');
  assert.deepEqual(classifyIdentity(`wa:${phone.slice(1)}`), { kind: 'phone', value: phone });
});

test('the duplicate warning never reads a BSUID channel id as a phone', async () => {
  const s = await scenario();
  const bsuid = syntheticBsuid();
  await seedContactWithIdentity(s.tenantId, s.clientId, 'external', bsuid);
  const typed = await findContactMatchesByIdentity(s.tenantId, s.clientId, legacyBsuidPhone(bsuid)!);
  assert.equal(typed.total, 0, 'typing the real phone does not "find" the BSUID contact');
  // A raw wa_id channel id still counts (the reason the scalar side exists).
  const waId = `5731${String(Date.now()).slice(-8)}`;
  await query(`INSERT INTO contacts (tenant_id, client_id, name, channel, channel_user_id) VALUES ($1,$2,'wa_id','whatsapp',$3)`, [s.tenantId, s.clientId, waId]);
  assert.equal((await findContactMatchesByIdentity(s.tenantId, s.clientId, `+${waId}`)).total, 1);
});

// ── Arrival order: a BSUID first, then a real customer whose phone is those digits ──

const identitiesOf = async (contactId: string) =>
  (await query<{ kind: string; value: string }>(`SELECT kind, value FROM contact_identities WHERE contact_id = $1 ORDER BY kind, value`, [contactId])).rows;

/** The real inbound path (handoff push → D-2): resolve the conversation_ref, link the conversation. */
async function inbound(s: { tenantId: string; clientId: string }, convId: string, ref: string) {
  await ensureContactForInboundMessage(s.tenantId, s.clientId, convId, ref, 'whatsapp');
  return linkedTo(convId);
}

async function arrivalOrderScenario(envAt: (step: 'bsuid' | 'real' | 'later') => string | undefined) {
  const setEnv = (v: string | undefined) => {
    if (v === undefined) delete process.env.BSUID_IDENTITY_MODE;
    else process.env.BSUID_IDENTITY_MODE = v;
  };
  const s = await scenario();
  const bsuid = syntheticBsuid();
  const digits = legacyBsuidPhone(bsuid)!; // what the old code would have invented
  const wf = `wf-${randomUUID().slice(0, 6)}`;
  await seedWorkflow(s.tenantId, s.clientId, wf);
  const bsuidConv = (await getOrCreateConversation(s.tenantId, wf, bsuid)).id;
  const phoneConv = (await getOrCreateConversation(s.tenantId, wf, digits.slice(1))).id; // wa_id form

  try {
    // 1. The BSUID writes first.
    setEnv(envAt('bsuid'));
    const a = await inbound(s, bsuidConv, bsuid);
    assert.ok(a);
    assert.deepEqual(await identitiesOf(a!), [{ kind: 'external', value: bsuid }], 'no derived phone is stored');
    const holders = await query(`SELECT 1 FROM contact_identities WHERE tenant_id = $1 AND kind = 'phone' AND value = $2`, [s.tenantId, digits]);
    assert.equal(holders.rowCount, 0, 'nobody holds the derived phone');

    // 2. Then a REAL customer whose phone is exactly those digits.
    setEnv(envAt('real'));
    const b = await inbound(s, phoneConv, digits.slice(1));
    assert.ok(b);
    assert.notEqual(b, a, 'the real customer is NOT resolved as the BSUID person');
    assert.deepEqual(await identitiesOf(b!), [{ kind: 'phone', value: digits }]);
    const booked = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'booking', channelUserId: digits, phone: digits, name: 'Cliente real' });
    assert.equal(booked.contact.id, b, 'a booking with that phone is the real customer too');

    // 3. Later messages from both, link passes and the backfill: nothing crosses.
    setEnv(envAt('later'));
    assert.equal(await inbound(s, bsuidConv, bsuid), a);
    assert.equal(await inbound(s, phoneConv, digits.slice(1)), b);
    await linkNullConversationsByPhone(s.tenantId, s.clientId, a!);
    await linkNullConversationsByPhone(s.tenantId, s.clientId, b!);
    await backfillConversationContacts();
    assert.equal(await linkedTo(bsuidConv), a);
    assert.equal(await linkedTo(phoneConv), b);
    assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: bsuid }), [a]);
    assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, phone: digits }), [b]);
    assert.deepEqual(await identitiesOf(a!), [{ kind: 'external', value: bsuid }], 'still no derived phone on the BSUID contact');
    const n = await query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND client_id = $2`, [s.tenantId, s.clientId]);
    assert.equal(n.rows[0].n, 2, 'two people, two contacts');
  } finally {
    delete process.env.BSUID_IDENTITY_MODE;
  }
}

// The removed `dual` mode wrote a derived phone at step 1, so step 2 resolved the real
// customer to the BSUID contact. No value of the old variable may bring that back.
for (const v of [undefined, 'dual', 'DUAL', 'external', 'garbage', '']) {
  test(`arrival order BSUID → real phone stays two people (BSUID_IDENTITY_MODE=${JSON.stringify(v)})`, async () => {
    await arrivalOrderScenario(() => v);
  });
}

test('arrival order across a mode switch (dual → external → unset): still two people', async () => {
  await arrivalOrderScenario((step) => ({ bsuid: 'dual', real: 'external', later: undefined })[step]);
});

test('no identity code reads a mode switch', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/db/repositories/contactIdentities.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /process\.env|BSUID_IDENTITY_MODE/);
  const phone = readFileSync(fileURLToPath(new URL('../../src/scheduling/phone.ts', import.meta.url)), 'utf8');
  assert.doesNotMatch(phone, /process\.env/);
});

// ── Rollback parity with R0 (f7c4cf7), by BSUID length ──────────────────────────────
// Production (diagnostic 13 oct): 34 external BSUID identities — 32 of 16 digits, 1 of 17,
// 1 of 15. R0 reads a BSUID as a phone ONLY at 7–15 digits; otherwise it already keeps it
// external, exactly like the fix.

/** How R0's resolve MATCHES a push: the ref classified by R0, plus DECLARED identities (I-1). */
async function r0Lookup(
  tenantId: string,
  clientId: string,
  push: { ref: string; identities?: Array<{ kind: 'phone' | 'external'; value: string }> },
): Promise<string[]> {
  const pairs: Array<{ kind: string; value: string }> = [];
  const ref = r0ClassifyIdentity(push.ref);
  if (ref) pairs.push(ref);
  for (const d of push.identities ?? []) {
    const v = d.kind === 'phone' ? r0NormalizeE164(d.value) : d.value.trim(); // R0's classifyDeclaredIdentity
    if (v) pairs.push({ kind: d.kind, value: v });
  }
  const r = await query<{ contact_id: string }>(
    `SELECT DISTINCT contact_id FROM contact_identities
      WHERE tenant_id = $1 AND client_id = $2
        AND (kind, value) IN (SELECT * FROM unnest($3::text[], $4::text[]))`,
    [tenantId, clientId, pairs.map((p) => p.kind), pairs.map((p) => p.value)],
  );
  return r.rows.map((x) => x.contact_id).sort();
}
const bsuidOfLength = (n: number) => `CO.5${String(Date.now()).padStart(n - 1, '7').slice(-(n - 1))}`;

for (const n of [16, 17]) {
  test(`${n}-digit BSUID: the fix stores exactly what R0 looks up — a rollback to R0 finds the contact`, async () => {
    const s = await scenario();
    const v = bsuidOfLength(n);
    assert.equal(v.replace(/[^0-9]/g, '').length, n);
    assert.deepEqual(classifyIdentity(v), r0ClassifyIdentity(v), 'same classification as R0');
    assert.equal(legacyBsuidPhone(v), null, 'R0 never invented a phone for this length');
    const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: v });
    assert.deepEqual(await identitiesOf(contact.id), [{ kind: 'external', value: v }]);
    assert.deepEqual(await r0Lookup(s.tenantId, s.clientId, { ref: v }), [contact.id], 'R0 resolves the same contact');
  });

  test(`${n}-digit BSUID: a contact R0 created is found by the fix — no split`, async () => {
    const s = await scenario();
    const v = bsuidOfLength(n);
    // Exactly what R0 wrote for this value: an external identity, no phone.
    const r0Contact = await seedContactWithIdentity(s.tenantId, s.clientId, 'external', v);
    const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: v });
    assert.equal(contact.id, r0Contact);
    assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channelUserId: v }), [r0Contact]);
    const c = await query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND client_id = $2`, [s.tenantId, s.clientId]);
    assert.equal(c.rows[0].n, 1);
  });
}

test('15-digit BSUID as the conversation ref: the ONE length where R0 differs — R0 misses a fix-created contact unless the BSUID is declared', async () => {
  const s = await scenario();
  const v = bsuidOfLength(15);
  assert.deepEqual(r0ClassifyIdentity(v), { kind: 'phone', value: legacyBsuidPhone(v) }, 'R0 reads it as a phone');
  const { contact } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: v });
  assert.deepEqual(await identitiesOf(contact.id), [{ kind: 'external', value: v }], 'the fix: no derived phone');
  assert.deepEqual(await r0Lookup(s.tenantId, s.clientId, { ref: v }), [], 'R0 alone would not find it (the rollback risk Query 6 counts)');
  assert.deepEqual(
    await r0Lookup(s.tenantId, s.clientId, { ref: v, identities: [{ kind: 'external', value: v }] }),
    [contact.id],
    'but R0 does find it when the workflow DECLARES the BSUID as external (I-1)',
  );
});

test('15-digit BSUID that arrived DECLARED (ref = the wa_id phone): the fix and R0 resolve the same contact', async () => {
  const s = await scenario();
  const v = bsuidOfLength(15);
  const waId = `5731${String(Date.now()).slice(-8)}`;
  const push = { ref: waId, identities: [{ kind: 'external' as const, value: v }] };
  // As R0 created it (Query 10: channel_user_id phone-like, BSUID declared as external).
  const first = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: waId, identities: push.identities });
  assert.deepEqual(await identitiesOf(first.contact.id), [{ kind: 'external', value: v }, { kind: 'phone', value: `+${waId}` }]);
  const again = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: waId, identities: push.identities });
  assert.equal(again.contact.id, first.contact.id, 'the fix: same contact');
  assert.deepEqual(await r0Lookup(s.tenantId, s.clientId, push), [first.contact.id], 'R0: same contact');
  // Even a push carrying ONLY the BSUID as ref, if it still declares it: both find it.
  assert.deepEqual(await r0Lookup(s.tenantId, s.clientId, { ref: v, identities: push.identities }), [first.contact.id]);
  const viaBsuid = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: v });
  assert.equal(viaBsuid.contact.id, first.contact.id, 'the fix finds it by the BSUID alone too');
});
