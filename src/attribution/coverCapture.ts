import { clearCoverFetch, listAdsNeedingCover, saveAutoCover } from '../db/repositories/attribution.js';
import { adCoverStore, type AdCoverStore } from '../storage/publicImageStore.js';
import {
  COVER_FETCH_MAX_AGE_DAYS,
  COVER_FETCH_TIMEOUT_MS,
  MAX_AD_COVER_DOWNLOAD_BYTES,
  detectCoverImage,
  isAllowedCoverUrl,
} from './coverGuards.js';
import { recordAttributionFailure } from './ingest.js';

/**
 * AT-2c — AD COVER capture. A thumbnail_url / image_url Meta sends in a referral is a SIGNED fbcdn
 * link that expires in days, so the image is copied SERVER-SIDE into our public bucket and only the
 * key is kept. Ingestion never fetches on the message hot path — it queues the signed url on the ad
 * (ads.cover_fetch_url); this engine, run by the worker cover-reconcile, downloads it and stores it.
 *
 * SSRF / abuse guards (anything else is REFUSED and counted, never fetched) live in coverGuards.ts:
 *   - https only, and the host must be a Meta CDN host (allow-list);
 *   - NO redirects followed (a 3xx is refused — a redirect could leave the allowed host);
 *   - image content-type only, confirmed by magic bytes (png/jpeg/webp);
 *   - a size cap and a request timeout.
 *
 * Fail-safe: nothing here throws onto the message write (it isn't on that path at all). A permanent
 * refusal clears the queued url (no point retrying a bad url); a transient failure keeps it, so the
 * reconcile retries while the signed url is still valid (bounded by cover_fetch_seen_at freshness).
 * A person-uploaded cover (cover_source = 'manual') is never touched — saveAutoCover guards it.
 */

export type CaptureOutcome = 'stored' | 'refused' | 'failed' | 'superseded';
export interface CaptureResult {
  outcome: CaptureOutcome;
  reason?: string;
  key?: string;
}

export interface CaptureDeps {
  fetchImpl?: typeof fetch;
  store?: AdCoverStore;
  /** Download timeout override (tests). Defaults to COVER_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
}

/**
 * Download one ad's queued cover url (guarded), store it, and save the key. Never throws.
 *  - 'stored'     — downloaded + stored; cover_fetch_url cleared by saveAutoCover.
 *  - 'refused'    — a permanent guard refusal (bad url/host, redirect, non-image, oversize) → counted.
 *  - 'failed'     — a transient failure (timeout, network, http error, store error) → counted, retry.
 *  - 'superseded' — a manual cover took over (or the ad vanished) — the orphan upload is deleted.
 */
export async function captureAdCover(
  input: { tenantId: string; clientId: string; adId: string; fetchUrl: string },
  deps: CaptureDeps = {},
): Promise<CaptureResult> {
  const store = deps.store ?? adCoverStore;
  const doFetch = deps.fetchImpl ?? fetch;
  const fail = (outcome: Exclude<CaptureOutcome, 'stored' | 'superseded'>, reason: string, err?: unknown): CaptureResult => {
    recordAttributionFailure({ job: 'cover-capture', adId: input.adId, reason }, err);
    return { outcome, reason };
  };

  const guard = isAllowedCoverUrl(input.fetchUrl);
  if (!guard.ok) return fail('refused', guard.reason);

  let res: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? COVER_FETCH_TIMEOUT_MS);
  try {
    res = await doFetch(guard.url, { redirect: 'manual', signal: controller.signal, headers: { accept: 'image/*' } });
  } catch (err) {
    return fail('failed', 'fetch_error', err);
  } finally {
    clearTimeout(timer);
  }

  // No redirects: a 3xx is refused outright — following it could leave the allowed host.
  if (res.status >= 300 && res.status < 400) return fail('refused', 'redirect');
  if (!res.ok) return fail('failed', `http_${res.status}`); // transient — retry while the url is valid

  const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith('image/')) return fail('refused', 'not_image_content_type');
  const declaredLen = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declaredLen) && declaredLen > MAX_AD_COVER_DOWNLOAD_BYTES) return fail('refused', 'too_large');

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    return fail('failed', 'read_error', err);
  }
  if (bytes.length > MAX_AD_COVER_DOWNLOAD_BYTES) return fail('refused', 'too_large');
  const kind = detectCoverImage(bytes);
  if (!kind) return fail('refused', 'not_image_bytes');

  let key: string;
  try {
    key = await store.put({ tenantId: input.tenantId, clientId: input.clientId, adId: input.adId, bytes, ext: kind.ext, contentType: kind.contentType });
  } catch (err) {
    return fail('failed', 'store_error', err);
  }

  const saved = await saveAutoCover(input.tenantId, input.clientId, input.adId, key);
  if (!saved.ok) {
    // A manual cover was set (or the ad was deleted) between queueing and now — drop the orphan.
    await store.del(key).catch(() => {});
    return { outcome: 'superseded' };
  }
  if (saved.previousKey && saved.previousKey !== key) {
    await store.del(saved.previousKey).catch(() => {}); // replaced an older auto cover
  }
  return { outcome: 'stored', key };
}

/** One reconcile pass: download every ad with a fresh queued cover url. Returns the tally. */
export async function captureAdCoversOnce(
  opts: { tenantId?: string; limit?: number } = {},
  deps: CaptureDeps = {},
): Promise<{ attempted: number; stored: number; refused: number; failed: number; superseded: number }> {
  const rows = await listAdsNeedingCover({ tenantId: opts.tenantId, limit: opts.limit ?? 25, freshDays: COVER_FETCH_MAX_AGE_DAYS });
  const counts = { attempted: 0, stored: 0, refused: 0, failed: 0, superseded: 0 };
  for (const ad of rows) {
    if (!ad.cover_fetch_url) continue;
    counts.attempted += 1;
    const r = await captureAdCover({ tenantId: ad.tenant_id, clientId: ad.client_id, adId: ad.id, fetchUrl: ad.cover_fetch_url }, deps);
    if (r.outcome === 'stored') counts.stored += 1;
    else if (r.outcome === 'failed') counts.failed += 1; // keep the queued url; retry next cycle
    else if (r.outcome === 'refused') {
      counts.refused += 1;
      await clearCoverFetch(ad.tenant_id, ad.client_id, ad.id); // permanent — stop retrying this url
    } else if (r.outcome === 'superseded') {
      counts.superseded += 1;
      await clearCoverFetch(ad.tenant_id, ad.client_id, ad.id); // manual took over — cancel the queue
    }
  }
  return counts;
}
