import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  resolveContactByIdentity,
  findContactIdsByIdentity,
  findContactMatchesByIdentity,
} from '../../src/db/repositories/contactIdentities.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * MULTI-IDENTITY through the C-2 chokepoint — the `phones[]` / `emails[]` inputs the
 * manual contact form needs, and the read-only match lookup its inline duplicate check
 * uses.
 *
 * The point of these tests is the thing that could go WRONG. Adding extra identities
 * with a separate INSERT after resolving would look identical for the happy path and
 * would quietly skip the collision rules — so the tests below are mostly about
 * collisions, not about the happy path.
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
    // Sorted in JS, not SQL: Postgres's default collation orders 'camila@mail.com'
    // before 'camila.reyes@work.com', so an ORDER BY here would assert the collation
    // rather than the behaviour.
    .sort();

test('a contact created with TWO phones and TWO emails claims all four identities', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'manual',
    channelUserId: '+573001112233',
    name: 'Camila Reyes',
    phone: '+573001112233',
    email: 'camila@mail.com',
    phones: ['+573001112233', '+573185980405'],
    emails: ['camila@mail.com', 'camila.reyes@work.com'],
  });
  assert.deepEqual(await identitiesOf(contact.id), [
    '+573001112233',
    '+573185980405',
    'camila.reyes@work.com',
    'camila@mail.com',
  ].sort());
  // Each one now resolves back to the same person — including the SECONDARY ones,
  // which is the whole reason they went through buildIdentities.
  for (const v of ['+573185980405', 'camila.reyes@work.com']) {
    assert.deepEqual(await findContactIdsByIdentity({ tenantId: s.tenantId, clientId: s.clientId, phone: v, email: v }), [contact.id]);
  }
});

test('the scalar columns still come from `phone`/`email` alone — arrays are additive only', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'manual',
    channelUserId: '+573001112233',
    phone: '+573001112233',
    email: 'first@mail.com',
    phones: ['+573001112233', '+573185980405'],
    emails: ['first@mail.com', 'second@mail.com'],
  });
  assert.equal(contact.phone_e164, '+573001112233', 'the mirror column is the PRIMARY phone');
  assert.equal(contact.email, 'first@mail.com', 'not the last one in the array');
});

test('existing callers are unaffected: omitting the arrays behaves exactly as before', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: '573058830676',
  });
  assert.deepEqual(await identitiesOf(contact.id), ['+573058830676'], 'one identity, as before');
});

test('a SECONDARY email already owned by another contact does NOT fork — oldest wins, candidate recorded', async () => {
  const s = await scenario();
  // Someone already owns shared@mail.com.
  const { contact: first } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: 'shared@mail.com',
    email: 'shared@mail.com',
  });

  // Now a manual create whose PRIMARY is a brand-new phone but whose SECOND email is
  // that same address. If the extras bypassed the chokepoint's lookup this would
  // silently create a second contact — the exact duplicate C-2 exists to prevent.
  const { contact: second, candidatesRecorded } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'manual',
    channelUserId: '+573009998877',
    phone: '+573009998877',
    email: 'new@mail.com',
    phones: ['+573009998877'],
    emails: ['new@mail.com', 'shared@mail.com'],
  });

  assert.equal(second.id, first.id, 'resolved to the EXISTING contact, not a new one');
  assert.equal(candidatesRecorded, 0, 'one contact matched, so there is nothing to flag as a duplicate pair');
  const all = await identitiesOf(first.id);
  assert.ok(all.includes('+573009998877') && all.includes('new@mail.com'), 'the new identities were attached to it');

  const total = (await query<{ n: string }>(`SELECT count(*) n FROM contacts WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.clientId])).rows[0].n;
  assert.equal(Number(total), 1, 'still exactly ONE person');
});

test('when the typed identities span TWO existing contacts, the oldest survives and a duplicate candidate is recorded', async () => {
  const s = await scenario();
  const { contact: older } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '+573001112233',
  });
  // Force a distinguishable ordering (created_at drives "oldest wins").
  await query(`UPDATE contacts SET created_at = now() - interval '10 days' WHERE id=$1`, [older.id]);
  const { contact: newer } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'api', channelUserId: 'other@mail.com', email: 'other@mail.com',
  });
  assert.notEqual(newer.id, older.id, 'two separate people to begin with');

  const { contact: winner, candidatesRecorded } = await resolveContactByIdentity({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'manual',
    channelUserId: '+573001112233',
    phone: '+573001112233',
    phones: ['+573001112233'],
    emails: ['other@mail.com'],
  });
  assert.equal(winner.id, older.id, 'the OLDEST contact survives');
  assert.equal(candidatesRecorded, 1, 'and the collision is flagged for a human, never auto-merged');
  const flagged = (
    await query<{ n: string }>(`SELECT count(*) n FROM duplicate_contact_candidates WHERE tenant_id=$1 AND resolved_at IS NULL`, [s.tenantId])
  ).rows[0].n;
  assert.equal(Number(flagged), 1);
});

// ── The inline duplicate check ─────────────────────────────────────────────────

test('the match lookup is READ-ONLY: probing an unknown number creates nothing', async () => {
  const s = await scenario();
  const before = (await query<{ n: string }>(`SELECT count(*) n FROM contacts WHERE tenant_id=$1`, [s.tenantId])).rows[0].n;
  const r = await findContactMatchesByIdentity(s.tenantId, s.clientId, '+573001112233');
  assert.deepEqual(r, { matches: [], total: 0 });
  const after_ = (await query<{ n: string }>(`SELECT count(*) n FROM contacts WHERE tenant_id=$1`, [s.tenantId])).rows[0].n;
  assert.equal(after_, before, 'the check must never create the contact it is checking for');
});

test('the match lookup normalizes, so any typed form of a stored number is found', async () => {
  const s = await scenario();
  await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '573185980405', name: 'Camila',
  });
  for (const typed of ['+57 318 598 0405', '573185980405', '57-318-598-0405']) {
    const r = await findContactMatchesByIdentity(s.tenantId, s.clientId, typed);
    assert.equal(r.total, 1, `"${typed}" finds the stored E.164`);
    assert.equal(r.matches[0].name, 'Camila');
    assert.equal(r.matches[0].matched_value, '+573185980405', 'the card shows the STORED value');
  }
});

test('LEGACY rows with no identity row are still found — the duplicates that really exist', async () => {
  const s = await scenario();
  // A contact predating the C-2 spine: scalar phone only, no contact_identities row.
  // This is 4 of 5 contacts on the dev database, and an identities-only lookup told the
  // operator "no existe un contacto con este dato" about every one of them.
  const legacy = (
    await query<{ id: string }>(
      `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name, phone_e164, last_contact_at)
         VALUES ($1,$2,'whatsapp','573185980405','Legacy Camila','+573185980405', now()) RETURNING id`,
      [s.tenantId, s.clientId],
    )
  ).rows[0];
  const r = await findContactMatchesByIdentity(s.tenantId, s.clientId, '+57 318 598 0405');
  assert.equal(r.total, 1, 'found despite having no identity row');
  assert.equal(r.matches[0].contact_id, legacy.id);
  assert.equal(r.matches[0].name, 'Legacy Camila');
});

test('the raw un-normalized form stored on legacy rows also matches', async () => {
  const s = await scenario();
  // The brief notes the DB holds BOTH "+57 318…" and "573043906303". The raw form can
  // only live in channel_user_id: phone_e164 is CHECK-constrained to ^\+[1-9][0-9]{6,14}$,
  // so it is never the un-normalized one. This is the real shape of a WhatsApp-born
  // contact whose wa_id was recorded and whose phone_e164 was never filled.
  await query(
    `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, last_contact_at)
       VALUES ($1,$2,'whatsapp','573043906303', now())`,
    [s.tenantId, s.clientId],
  );
  for (const typed of ['+573043906303', '57 304 390 6303', '573043906303']) {
    assert.equal((await findContactMatchesByIdentity(s.tenantId, s.clientId, typed)).total, 1, typed);
  }
});

test('SEVERAL contacts on one number are all counted, and the list is capped at the limit', async () => {
  const s = await scenario();
  // Four legacy rows sharing one number — the exact state the reference's "Ya existen 3
  // contactos con este número" describes, and impossible to represent in
  // contact_identities (UNIQUE), which is why the query searches the scalar columns too.
  for (let i = 0; i < 4; i++) {
    await query(
      `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name, phone_e164, last_contact_at)
         VALUES ($1,$2,'whatsapp','573185980405',$3,'+573185980405', now())`,
      [s.tenantId, s.clientId, i === 0 ? 'Camila Reyes' : null],
    );
  }
  const r = await findContactMatchesByIdentity(s.tenantId, s.clientId, '+573185980405', { limit: 3 });
  assert.equal(r.total, 4, 'the heading counts every one of them');
  assert.equal(r.matches.length, 3, 'the list shows at most three');
  assert.equal(r.matches[0].name, 'Camila Reyes', 'oldest first — the survivor the spine would pick');
});

test('the lookup can exclude the contact being edited, so it never flags itself', async () => {
  const s = await scenario();
  const { contact } = await resolveContactByIdentity({
    tenantId: s.tenantId, clientId: s.clientId, channel: 'manual', channelUserId: '+573185980405', phone: '+573185980405',
  });
  const included = await findContactMatchesByIdentity(s.tenantId, s.clientId, '+573185980405');
  assert.equal(included.total, 1);
  const excluded = await findContactMatchesByIdentity(s.tenantId, s.clientId, '+573185980405', { excludeContactId: contact.id });
  assert.equal(excluded.total, 0, 'editing a contact must not warn about the contact itself');
});

test('the lookup is client-scoped: another client with the same number is invisible', async () => {
  const a = await scenario();
  const b = await scenario();
  await resolveContactByIdentity({ tenantId: a.tenantId, clientId: a.clientId, channel: 'manual', channelUserId: '+573185980405', phone: '+573185980405' });
  const cross = await findContactMatchesByIdentity(b.tenantId, b.clientId, '+573185980405');
  assert.equal(cross.total, 0, 'a phone in another tenant/client can never surface here');
});
