import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { captureAdCover, captureAdCoversOnce } from '../../src/attribution/coverCapture.js';
import { MAX_AD_COVER_DOWNLOAD_BYTES } from '../../src/attribution/coverGuards.js';
import { getAttributionFailureCount } from '../../src/attribution/ingest.js';
import type { AdCoverStore } from '../../src/storage/publicImageStore.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

const { POST: Messages } = await import('../../web/app/api/handoff/v1/messages/route.js');
after(closeDb);

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

/** A valid tiny JPEG (magic bytes FF D8 FF …). */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const ALLOWED = 'https://scontent.xx.fbcdn.net/v/t45/cover.jpg';

/** A fake object store that records puts/dels in memory (no real R2). */
function fakeStore(): AdCoverStore & { puts: Map<string, { contentType: string }>; dels: string[] } {
  const puts = new Map<string, { contentType: string }>();
  const dels: string[] = [];
  return {
    puts,
    dels,
    async put({ tenantId, clientId, adId, ext, contentType }) {
      const key = `ads/${tenantId}/${clientId}/${adId}/test-${puts.size}.${ext}`;
      puts.set(key, { contentType });
      return key;
    },
    async del(key: string) {
      dels.push(key);
    },
  };
}

const respond = (body: BodyInit | null, init: ResponseInit): typeof fetch =>
  (async () => new Response(body, init)) as unknown as typeof fetch;
const okImage = (bytes = JPEG, contentType = 'image/jpeg', headers: Record<string, string> = {}): typeof fetch =>
  respond(bytes, { status: 200, headers: { 'content-type': contentType, 'content-length': String(bytes.length), ...headers } });

async function seedAd(
  s: Awaited<ReturnType<typeof seedScenario>>,
  patch: { externalId?: string; coverFetchUrl?: string | null; seenAgo?: string; coverSource?: string | null; coverImageKey?: string | null; clientId?: string } = {},
): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, cover_fetch_url, cover_fetch_seen_at, cover_source, cover_image_key)
       VALUES ($1,$2,'meta','ad',$3, $4::text,
               CASE WHEN $4::text IS NULL THEN NULL ELSE now() - ($5::text)::interval END, $6::text, $7::text) RETURNING id`,
    [s.tenantId, patch.clientId ?? s.clientId, patch.externalId ?? `9${Math.floor(Math.random() * 1e8)}`,
      patch.coverFetchUrl ?? null, patch.seenAgo ?? '0 seconds', patch.coverSource ?? null, patch.coverImageKey ?? null],
  );
  return r.id;
}

test('AT-2c capture: an allowed Meta-CDN image is downloaded, stored, and the queue cleared', async () => {
  const s = await seedScenario();
  try {
    const adId = await seedAd(s, { coverFetchUrl: ALLOWED });
    const store = fakeStore();
    const r = await captureAdCover({ tenantId: s.tenantId, clientId: s.clientId, adId, fetchUrl: ALLOWED }, { fetchImpl: okImage(), store });
    assert.equal(r.outcome, 'stored');
    assert.equal(store.puts.size, 1, 'the image was stored once');
    const ad = await one<{ cover_image_key: string | null; cover_source: string | null; cover_fetch_url: string | null }>(
      `SELECT cover_image_key, cover_source, cover_fetch_url FROM ads WHERE id=$1`, [adId]);
    assert.ok(ad.cover_image_key, 'the key is saved');
    assert.equal(ad.cover_source, 'auto');
    assert.equal(ad.cover_fetch_url, null, 'the queue is cleared on success');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2c capture guards: disallowed host, redirect, non-image type, non-image bytes and oversize are all REFUSED and counted', async () => {
  const s = await seedScenario();
  try {
    const store = fakeStore();
    const cases: Array<{ name: string; url: string; fetchImpl?: typeof fetch }> = [
      { name: 'disallowed host', url: 'https://evil.example.com/x.jpg', fetchImpl: okImage() },
      { name: 'redirect to another host', url: ALLOWED, fetchImpl: respond('', { status: 302, headers: { location: 'https://evil.example.com/x' } }) },
      { name: 'non-image content-type', url: ALLOWED, fetchImpl: okImage(JPEG, 'text/html') },
      { name: 'non-image bytes', url: ALLOWED, fetchImpl: okImage(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]), 'image/jpeg') },
      { name: 'oversize (declared)', url: ALLOWED, fetchImpl: okImage(JPEG, 'image/jpeg', { 'content-length': String(MAX_AD_COVER_DOWNLOAD_BYTES + 1) }) },
    ];
    for (const c of cases) {
      const before = getAttributionFailureCount();
      const adId = await seedAd(s, { coverFetchUrl: c.url });
      const r = await captureAdCover({ tenantId: s.tenantId, clientId: s.clientId, adId, fetchUrl: c.url }, { fetchImpl: c.fetchImpl, store });
      assert.equal(r.outcome, 'refused', `${c.name} → refused`);
      assert.equal(getAttributionFailureCount(), before + 1, `${c.name} → counted`);
    }
    assert.equal(store.puts.size, 0, 'nothing was ever stored');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2c capture: a timeout is a TRANSIENT failure (counted, queue retained) and the reconcile RETRIES', async () => {
  const s = await seedScenario();
  try {
    const store = fakeStore();
    const adId = await seedAd(s, { coverFetchUrl: ALLOWED });
    // A hung fetch that only settles when aborted — with a tiny timeout it fails fast.
    const hangFetch = ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')));
      })) as unknown as typeof fetch;

    const before = getAttributionFailureCount();
    const first = await captureAdCoversOnce({ tenantId: s.tenantId }, { fetchImpl: hangFetch, store, timeoutMs: 20 });
    assert.deepEqual({ failed: first.failed, stored: first.stored }, { failed: 1, stored: 0 });
    assert.equal(getAttributionFailureCount(), before + 1, 'the transient failure is counted');
    assert.equal((await one<{ u: string | null }>(`SELECT cover_fetch_url u FROM ads WHERE id=$1`, [adId])).u, ALLOWED, 'the queue is RETAINED for retry');

    // Next pass: the CDN responds — the reconcile retries and stores it.
    const second = await captureAdCoversOnce({ tenantId: s.tenantId }, { fetchImpl: okImage(), store });
    assert.equal(second.stored, 1, 'the retry stored the cover');
    assert.equal((await one<{ k: string | null }>(`SELECT cover_image_key k FROM ads WHERE id=$1`, [adId])).k !== null, true);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2c reconcile: a permanently-refused url is cleared so it is not retried forever', async () => {
  const s = await seedScenario();
  try {
    const adId = await seedAd(s, { coverFetchUrl: 'https://evil.example.com/x.jpg' });
    const c = await captureAdCoversOnce({ tenantId: s.tenantId }, { fetchImpl: okImage(), store: fakeStore() });
    assert.equal(c.refused, 1);
    assert.equal((await one<{ u: string | null }>(`SELECT cover_fetch_url u FROM ads WHERE id=$1`, [adId])).u, null, 'a permanent refusal clears the queue');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2c: a person-uploaded (manual) cover is NEVER overwritten by automatic capture', async () => {
  const s = await seedScenario();
  try {
    // A manual cover, plus a (forced) queued url that should never win.
    const adId = await seedAd(s, { coverFetchUrl: ALLOWED, coverSource: 'manual', coverImageKey: 'ads/manual/keep.jpg' });
    // (a) the work list excludes manual covers entirely.
    const work = await (await import('../../src/db/repositories/attribution.js')).listAdsNeedingCover({ tenantId: s.tenantId });
    assert.equal(work.find((w) => w.id === adId), undefined, 'a manual ad is not in the capture work list');
    // (b) even called directly, saveAutoCover refuses — the manual cover is left intact and the orphan dropped.
    const store = fakeStore();
    const r = await captureAdCover({ tenantId: s.tenantId, clientId: s.clientId, adId, fetchUrl: ALLOWED }, { fetchImpl: okImage(), store });
    assert.equal(r.outcome, 'superseded');
    assert.equal(store.dels.length, 1, 'the just-uploaded orphan is deleted');
    const ad = await one<{ cover_image_key: string; cover_source: string }>(`SELECT cover_image_key, cover_source FROM ads WHERE id=$1`, [adId]);
    assert.deepEqual(ad, { cover_image_key: 'ads/manual/keep.jpg', cover_source: 'manual' }, 'the manual cover is untouched');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2c isolation: capture is tenant+client scoped; a wrong client never writes, a stale queue is skipped', async () => {
  const s = await seedScenario();
  try {
    const adId = await seedAd(s, { coverFetchUrl: ALLOWED });
    // A wrong client id can't capture into this ad (saveAutoCover is scoped) — it supersedes, writes nothing.
    const store = fakeStore();
    const r = await captureAdCover({ tenantId: s.tenantId, clientId: s.otherClientId, adId, fetchUrl: ALLOWED }, { fetchImpl: okImage(), store });
    assert.equal(r.outcome, 'superseded');
    assert.equal((await one<{ k: string | null }>(`SELECT cover_image_key k FROM ads WHERE id=$1`, [adId])).k, null, 'the real ad was not written');
    // A stale queued url (older than the freshness window) is not in the work list.
    const staleId = await seedAd(s, { coverFetchUrl: ALLOWED, seenAgo: '5 days' });
    const work = await (await import('../../src/db/repositories/attribution.js')).listAdsNeedingCover({ tenantId: s.tenantId });
    assert.equal(work.find((w) => w.id === staleId), undefined, 'a stale (expired) queued url is skipped');
    assert.ok(work.find((w) => w.id === adId), 'the fresh queued url is still listed');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2c live: a referral thumbnail_url is QUEUED on the ad and the message write is unaffected (no hot-path download)', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['handoff']);
    const r = await Messages(new Request('http://t/api/handoff/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workflow_ref: wfRef, conversation_ref: '573001234567', sender: 'user', text: 'hola', external_message_id: 'm1',
        metadata: {
          referral_source_type: 'ad', referral_source_id: '900555',
          referral_thumbnail_url: ALLOWED, referral_video_url: 'https://www.facebook.com/story.php?story_fbid=1',
        },
      }),
    }));
    assert.ok(r.status === 201 || r.status === 200, 'the message write succeeds');
    const ad = await one<{ cover_fetch_url: string | null; cover_image_key: string | null; video_url: string | null }>(
      `SELECT cover_fetch_url, cover_image_key, video_url FROM ads WHERE tenant_id=$1 AND external_id='900555'`, [s.tenantId]);
    assert.equal(ad.cover_fetch_url, ALLOWED, 'the signed cover url is queued (not fetched on the hot path)');
    assert.equal(ad.cover_image_key, null, 'no cover downloaded during the message write');
    assert.equal(ad.video_url, 'https://www.facebook.com/story.php?story_fbid=1', 'the video link is stored as a plain link');
  } finally { await cleanupTenant(s.tenantId); }
});
