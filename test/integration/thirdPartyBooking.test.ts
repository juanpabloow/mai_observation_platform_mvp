import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { getOrCreateConversation } from '../../src/db/repositories/handoff.js';
import { ensureContactForInboundMessage } from '../../src/db/repositories/contactIdentities.js';
import { normalizeE164, dialingRegionForTimezone } from '../../src/scheduling/phone.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * QA-3: a customer books from their OWN WhatsApp for a third party. customer_phone identifies
 * WHO THE APPOINTMENT IS FOR (resolve/create that contact); channel_user_id/conversation_ref
 * identify WHERE THE REQUEST CAME FROM (attribution only). The writer's conversation must
 * NEVER be re-pointed to the third party, and the third party's local number must resolve to
 * the same contact as its wa_id form.
 */
const TZ = 'America/Bogota';
const NOW0 = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ);
const WRITER_WA = '573058830676'; // wa_id → +573058830676
const BROTHER_LOCAL = '3058830677'; // typed locally → +573058830677
const BROTHER_E164 = '+573058830677';

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

async function scenario() {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  tenants.push(s.tenantId);
  await seedWorkflow(s.tenantId, s.clientId, 'wf1');
  return s;
}
/** D-2 reality: the writer messaged, so their conversation exists AND is linked to them. */
async function setupWriter(s: Awaited<ReturnType<typeof scenario>>) {
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', WRITER_WA);
  await ensureContactForInboundMessage(s.tenantId, s.clientId, conv.id, WRITER_WA, 'whatsapp');
  const writerContactId = (await query<{ contact_id: string }>(`SELECT contact_id FROM conversations WHERE id=$1`, [conv.id])).rows[0].contact_id;
  return { conv, writerContactId };
}
function book(s: Awaited<ReturnType<typeof scenario>>, overrides: Record<string, unknown>) {
  return createAppointment({
    tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA,
    startAt: wed(10), workflowRef: 'wf1', conversationRef: WRITER_WA,
    channel: 'whatsapp', channelUserId: WRITER_WA,
    origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, idempotencyKey: null, now: NOW0,
    ...overrides,
  });
}
const contactCount = async (s: { tenantId: string; clientId: string }): Promise<number> =>
  (await query<{ n: number }>(`SELECT count(*)::int n FROM contacts WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.clientId])).rows[0].n;
const convContact = async (id: string): Promise<string | null> =>
  (await query<{ contact_id: string | null }>(`SELECT contact_id FROM conversations WHERE id=$1`, [id])).rows[0].contact_id;
const identsOf = async (contactId: string): Promise<string[]> =>
  (await query<{ value: string }>(`SELECT value FROM contact_identities WHERE contact_id=$1 ORDER BY value`, [contactId])).rows.map((r) => r.value);

test('third-party booking creates the ATTENDEE contact; the appointment is theirs; the writer is untouched', async () => {
  const s = await scenario();
  const { writerContactId } = await setupWriter(s);
  const before = await contactCount(s);
  const r = await book(s, { customerPhone: BROTHER_LOCAL, customerName: 'Hermano' });
  assert.ok(r.ok, 'booking succeeds');
  if (!r.ok) throw new Error('unreachable');
  assert.notEqual(r.value.contact_id, writerContactId, 'appointment belongs to the brother, NOT the writer');
  assert.deepEqual(await identsOf(r.value.contact_id!), [BROTHER_E164], "brother's local number resolved to +57 and is his identity");
  assert.deepEqual(await identsOf(writerContactId), ['+573058830676'], "the writer keeps ONLY their own number — the brother's was not glued on");
  assert.equal(await contactCount(s), before + 1, 'exactly one new contact (the brother)');
});

test("the writer's conversation stays linked to the WRITER; the appointment attributes to it", async () => {
  const s = await scenario();
  const { conv, writerContactId } = await setupWriter(s);
  const r = await book(s, { customerPhone: BROTHER_LOCAL, customerName: 'Hermano' });
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  assert.equal(await convContact(conv.id), writerContactId, "the writer's conversation was NOT re-pointed to the brother");
  assert.equal(r.value.source_conversation_id, conv.id, 'but the appointment records where it came from');
});

test('customer_phone equal to the WRITER resolves to the writer (degrades gracefully, no duplicate)', async () => {
  const s = await scenario();
  const { writerContactId } = await setupWriter(s);
  const before = await contactCount(s);
  const r = await book(s, { customerPhone: '3058830676' }); // the writer's OWN number, typed locally
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  assert.equal(r.value.contact_id, writerContactId, 'resolves to the writer');
  assert.equal(await contactCount(s), before, 'no duplicate contact');
});

test('booking with ONLY channel_user_id is unchanged: the writer is the customer, conversation linked', async () => {
  const s = await scenario();
  const conv = await getOrCreateConversation(s.tenantId, 'wf1', WRITER_WA); // NULL contact (no prior D-2)
  const r = await book(s, {}); // no customer_phone
  assert.ok(r.ok);
  if (!r.ok) throw new Error('unreachable');
  assert.deepEqual(await identsOf(r.value.contact_id!), ['+573058830676'], 'writer resolved from the wa_id');
  assert.equal(await convContact(conv.id), r.value.contact_id, 'the writer conversation links to the writer (null-guarded)');
  assert.equal(r.value.source_conversation_id, conv.id);
});

test('a LOCAL 10-digit number and the same number WITH country code resolve to ONE contact', async () => {
  const s = await scenario();
  await setupWriter(s);
  const r1 = await book(s, { customerPhone: '3058830680' }); // local
  const r2 = await book(s, { customerPhone: '573058830680', startAt: wed(12) }); // wa_id / CC form, different slot
  assert.ok(r1.ok && r2.ok);
  if (!r1.ok || !r2.ok) throw new Error('unreachable');
  assert.equal(r1.value.contact_id, r2.value.contact_id, 'same person → one contact (no duplicate the first time they write themselves)');
});

test('an unparseable number → invalid_phone, and NO contact is created (zero writes)', async () => {
  const s = await scenario();
  await setupWriter(s);
  const before = await contactCount(s);
  const r = await book(s, { customerPhone: '88830676' }); // 8 digits — ambiguous for +57
  assert.equal(r.ok, false, 'booking is refused');
  if (r.ok) throw new Error('should have failed');
  assert.equal(r.error, 'invalid_phone');
  assert.equal(await contactCount(s), before, 'no contact created');
});

test('every STORED identity value normalizes to itself (wa_id-origin and local-origin alike)', async () => {
  const s = await scenario();
  await setupWriter(s); // writer via wa_id → +573058830676
  await book(s, { customerPhone: BROTHER_LOCAL }); // brother via local → +573058830677
  const rows = (await query<{ value: string }>(`SELECT value FROM contact_identities WHERE tenant_id=$1 AND kind='phone'`, [s.tenantId])).rows;
  assert.ok(rows.length >= 2, 'both contacts have a phone identity');
  const CO = dialingRegionForTimezone(TZ);
  for (const { value } of rows) {
    assert.equal(normalizeE164(value), value, `${value} stable under default normalize`);
    assert.equal(normalizeE164(value, { defaultRegion: CO }), value, `${value} stable under region normalize`);
  }
});
