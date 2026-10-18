import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { resolveContactByIdentity, mergeContacts } from '../../src/db/repositories/contactIdentities.js';
import { setAttributionTrackingStartedAt, setContactOrigin } from '../../src/db/repositories/attribution.js';
import { backfillAttribution } from '../../src/attribution/backfill.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { cleanupTenant, closeDb, seedContact, seedScenario, seedWorkflow } from './fixtures.js';

const { POST: Messages } = await import('../../web/app/api/handoff/v1/messages/route.js');

after(closeDb);

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const wed = (h: number): Date => zonedPartsToUtc(2026, 8, 5, h, 0, TZ);

async function handoff(s: Awaited<ReturnType<typeof seedScenario>>) {
  const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
  const { rawToken } = await issueToken(s.tenantId, connectionId, ['handoff']);
  const post = (body: Record<string, unknown>) => Messages(new Request('http://t/api/handoff/v1/messages', {
    method: 'POST', headers: { Authorization: `Bearer ${rawToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ workflow_ref: wfRef, ...body }),
  }));
  return { wfRef, post };
}
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];
const count = async (sql: string, params: unknown[]): Promise<number> => (await query<{ n: number }>(sql, params)).rows[0].n;

test('AT-1 live: a referral on a new contact → ad + touch + meta_ad origin + timeline events', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const { post } = await handoff(s);
    const r = await post({ conversation_ref: '573001234567', sender: 'user', text: 'hola', external_message_id: 'm1', metadata: { referral_source_type: 'ad', referral_source_id: '900100', referral_ctwa_clid: 'clid-x', referral_headline: 'Corte' } });
    assert.equal(r.status, 201);

    const ad = await one<{ source_type: string; is_test: boolean; headline: string }>(`SELECT source_type, is_test, headline FROM ads WHERE tenant_id=$1 AND external_id='900100'`, [s.tenantId]);
    assert.deepEqual({ t: ad.source_type, test: ad.is_test }, { t: 'ad', test: false });
    const touch = await one<{ ctwa_clid: string }>(`SELECT ctwa_clid FROM attribution_touches WHERE tenant_id=$1`, [s.tenantId]);
    assert.equal(touch.ctwa_clid, 'clid-x', 'ctwa_clid stored');
    const ct = await one<{ origin_kind: string; first_touch_id: string | null; latest_touch_id: string | null }>(`SELECT origin_kind, first_touch_id, latest_touch_id FROM contacts WHERE tenant_id=$1`, [s.tenantId]);
    assert.equal(ct.origin_kind, 'meta_ad');
    assert.ok(ct.first_touch_id && ct.latest_touch_id);
    // Timeline events: origin_set + attribution_touch.
    assert.equal(await count(`SELECT count(*)::int n FROM crm_activity_events WHERE tenant_id=$1 AND event_type='attribution_touch'`, [s.tenantId]), 1);
    assert.equal(await count(`SELECT count(*)::int n FROM crm_activity_events WHERE tenant_id=$1 AND event_type='origin_set'`, [s.tenantId]), 1);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 live: replay makes no second touch; a second ad on an existing contact adds a touch but origin/first_touch never change', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const { post } = await handoff(s);
    await post({ conversation_ref: '573009', sender: 'user', text: 'a', external_message_id: 'm1', metadata: { referral_source_type: 'ad', referral_source_id: '111' } });
    const firstTouch = (await one<{ first_touch_id: string }>(`SELECT first_touch_id FROM contacts WHERE tenant_id=$1`, [s.tenantId])).first_touch_id;
    // Replay m1 → no second touch.
    await post({ conversation_ref: '573009', sender: 'user', text: 'a', external_message_id: 'm1', metadata: { referral_source_type: 'ad', referral_source_id: '111' } });
    assert.equal(await count(`SELECT count(*)::int n FROM attribution_touches WHERE tenant_id=$1`, [s.tenantId]), 1, 'replay wrote no second touch');
    // A NEW message with a DIFFERENT ad → a second touch; origin + first_touch unchanged; latest moves.
    await post({ conversation_ref: '573009', sender: 'user', text: 'b', external_message_id: 'm2', metadata: { referral_source_type: 'ad', referral_source_id: '222' } });
    assert.equal(await count(`SELECT count(*)::int n FROM attribution_touches WHERE tenant_id=$1`, [s.tenantId]), 2);
    const ct = await one<{ origin_kind: string; first_touch_id: string; latest_touch_id: string }>(`SELECT origin_kind, first_touch_id, latest_touch_id FROM contacts WHERE tenant_id=$1`, [s.tenantId]);
    assert.equal(ct.origin_kind, 'meta_ad');
    assert.equal(ct.first_touch_id, firstTouch, 'first_touch unchanged');
    assert.notEqual(ct.latest_touch_id, firstTouch, 'latest_touch moved to the new touch');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 live: an invalid referral stores the message and writes no touch', async () => {
  // (The failure COUNTER is asserted in attributionFailsafe.test.ts, where the ingest module is
  // mocked — the route imports it via @worker/* and a relative import here would be a different
  // module instance. In production the route + health endpoint share the @worker/* instance.)
  const s = await seedScenario({ enableCrm: true });
  try {
    const { post } = await handoff(s);
    const r = await post({ conversation_ref: '573007', sender: 'user', text: 'x', external_message_id: 'mX', metadata: { referral_source_type: 'carousel', referral_source_id: '5' } });
    assert.ok(r.status === 201 || r.status === 200, 'message still stored');
    assert.equal(await count(`SELECT count(*)::int n FROM attribution_touches WHERE tenant_id=$1`, [s.tenantId]), 0, 'no touch for an invalid referral');
    assert.equal(await count(`SELECT count(*)::int n FROM handoff_messages WHERE tenant_id=$1`, [s.tenantId]), 1, 'the message is stored');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 backfill: dry writes nothing; apply matches dry; second apply is a no-op; TEST ad flagged', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    await setAttributionTrackingStartedAt(s.tenantId, s.clientId, new Date('2026-01-01T00:00:00Z'));
    const mk = async (contact: string, when: string, meta: Record<string, string> | null) => {
      const cv = await one<{ id: string }>(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [s.tenantId, wfRef, `c-${contact}-${when}`, contact]);
      await query(`INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at, metadata) VALUES ($1,$2,'user','received','m','text',$3,$4)`, [s.tenantId, cv.id, when, meta ? JSON.stringify(meta) : null]);
    };
    const cAd = await seedContact(s.tenantId, s.clientId, { name: 'A', channelUserId: 'wa:a' });
    const cTest = await seedContact(s.tenantId, s.clientId, { name: 'T', channelUserId: 'wa:t' });
    const cOrg = await seedContact(s.tenantId, s.clientId, { name: 'O', channelUserId: 'wa:o' });
    await mk(cAd, '2026-06-01T10:00:00Z', { referral_source_type: 'ad', referral_source_id: '900900' });
    await mk(cTest, '2026-06-02T10:00:00Z', { referral_source_type: 'ad', referral_source_id: 'TEST-9' });
    await mk(cOrg, '2026-06-03T10:00:00Z', null);

    const dry = await backfillAttribution({ tenantId: s.tenantId, apply: false });
    assert.equal(await count(`SELECT count(*)::int n FROM attribution_touches WHERE tenant_id=$1`, [s.tenantId]), 0, 'dry run wrote nothing');
    assert.equal(dry.touchesWritten, 2);
    assert.equal(dry.byOrigin.meta_ad, 2); // the ad contact AND the test-ad contact
    assert.equal(dry.byOrigin.organic_whatsapp, 1);
    assert.ok(dry.byAd.find((a) => a.external_id === 'TEST-9')?.is_test, 'TEST ad flagged');

    const applied = await backfillAttribution({ tenantId: s.tenantId, apply: true });
    assert.deepEqual({ t: applied.touchesWritten, o: applied.byOrigin }, { t: dry.touchesWritten, o: dry.byOrigin }, 'apply matches dry');
    assert.equal(await count(`SELECT count(*)::int n FROM attribution_touches WHERE tenant_id=$1`, [s.tenantId]), 2);

    const again = await backfillAttribution({ tenantId: s.tenantId, apply: true });
    assert.equal(again.touchesWritten, 0, 'second apply writes no touch');
    assert.equal(again.originsSet, 0, 'second apply sets no origin');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 merge keeps the EARLIEST first touch and moves touches', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const keep = await seedContact(s.tenantId, s.clientId, { name: 'Keep', channelUserId: 'wa:k' });
    const drop = await seedContact(s.tenantId, s.clientId, { name: 'Drop', channelUserId: 'wa:d' });
    // An ad row + two touches: drop's is EARLIER than keep's.
    const adId = (await one<{ id: string }>(`INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad','4242') RETURNING id`, [s.tenantId, s.clientId])).id;
    const cvK = (await one<{ id: string }>(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref) VALUES ($1,$2,'k') RETURNING id`, [s.tenantId, wfRef])).id;
    const cvD = (await one<{ id: string }>(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref) VALUES ($1,$2,'d') RETURNING id`, [s.tenantId, wfRef])).id;
    const mk = async (cv: string, contact: string, when: string) => {
      const m = await one<{ id: string }>(`INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, content_type, occurred_at) VALUES ($1,$2,'user','received','text',$3) RETURNING id`, [s.tenantId, cv, when]);
      return (await one<{ id: string }>(`INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [s.tenantId, s.clientId, contact, cv, m.id, adId, when])).id;
    };
    const dropTouch = await mk(cvD, drop, '2026-05-01T10:00:00Z'); // earliest
    await mk(cvK, keep, '2026-07-01T10:00:00Z');

    const res = await mergeContacts(s.tenantId, s.clientId, keep, drop, null);
    assert.equal(res.ok, true);
    assert.equal(await count(`SELECT count(*)::int n FROM attribution_touches WHERE contact_id=$1`, [keep]), 2, 'both touches on the survivor');
    const survivor = await one<{ first_touch_id: string; origin_kind: string }>(`SELECT first_touch_id, origin_kind FROM contacts WHERE id=$1`, [keep]);
    assert.equal(survivor.first_touch_id, dropTouch, 'first_touch = the earliest touch across both');
    assert.equal(survivor.origin_kind, 'meta_ad', 'the earliest ad touch defines the origin');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 booked_by_contact: an n8n booking for a customer_phone, sender looked up, sets booked_by_contact', async () => {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  try {
    // The SENDER already has a contact (from their own inbound message identity).
    const { contact: sender } = await resolveContactByIdentity({ tenantId: s.tenantId, clientId: s.clientId, channel: 'whatsapp', channelUserId: '573001110000', phone: '573001110000' });
    const r = await createAppointment({
      tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(10),
      customerPhone: '573002220000', channel: 'whatsapp', channelUserId: '573001110000',
      origin: 'n8n', createdByType: 'n8n', scopeClientId: s.clientId, now: NOW,
    });
    assert.ok(r.ok, 'booking succeeds');
    const attendee = await one<{ origin_kind: string; origin_ref_contact_id: string | null }>(`SELECT origin_kind, origin_ref_contact_id FROM contacts WHERE tenant_id=$1 AND phone_e164='+573002220000'`, [s.tenantId]);
    assert.equal(attendee.origin_kind, 'booked_by_contact');
    assert.equal(attendee.origin_ref_contact_id, sender.id, 'origin_ref points at the booker (sender) contact');
    // The sender themself is untouched.
    assert.equal((await one<{ origin_kind: string | null }>(`SELECT origin_kind FROM contacts WHERE id=$1`, [sender.id])).origin_kind, null);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 booking_page: a public booking creates a contact with origin booking_page', async () => {
  const s = await seedScenario({ enableScheduling: true, enableCrm: true });
  try {
    const r = await createAppointment({
      tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: s.staffA, startAt: wed(11),
      customerPhone: '573005550000', channel: 'public', channelUserId: '573005550000',
      origin: 'public', createdByType: 'public', scopeClientId: s.clientId, now: NOW,
    });
    assert.ok(r.ok);
    assert.equal((await one<{ origin_kind: string }>(`SELECT origin_kind FROM contacts WHERE tenant_id=$1 AND phone_e164='+573005550000'`, [s.tenantId])).origin_kind, 'booking_page');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 isolation: ads, campaigns and touches are tenant + client scoped', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    // An ad + campaign for clientId; none visible to otherClientId.
    await query(`INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad','7001')`, [s.tenantId, s.clientId]);
    await query(`INSERT INTO campaigns (tenant_id, client_id, name) VALUES ($1,$2,'Winter')`, [s.tenantId, s.clientId]);
    assert.equal(await count(`SELECT count(*)::int n FROM ads WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.clientId]), 1);
    assert.equal(await count(`SELECT count(*)::int n FROM ads WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.otherClientId]), 0, 'ad not visible to the other client');
    assert.equal(await count(`SELECT count(*)::int n FROM campaigns WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.otherClientId]), 0, 'campaign not visible to the other client');
    // The composite FK forbids an ad whose (client,tenant) pair isn't a real client of the tenant.
    await assert.rejects(
      query(`INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad','8001')`, [s.tenantId, '00000000-0000-0000-0000-000000000000']),
      /foreign key|violates/,
      'an ad for a non-client is rejected by the composite FK',
    );
  } finally { await cleanupTenant(s.tenantId); }
});
