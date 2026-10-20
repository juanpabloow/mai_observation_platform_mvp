/**
 * AT-2c — PURE guards + constants for ad-cover capture. Kept free of DB/SDK imports so they are
 * directly unit-testable (no DATABASE_URL / no R2). coverCapture.ts composes these with the network
 * fetch + the object store + the DB writes.
 */

/** Meta CDN host suffixes the downloader will fetch from. A single, easily-extended allow-list. */
export const META_CDN_HOST_SUFFIXES = ['.fbcdn.net'] as const;
/** Abuse cap on a downloaded cover (Meta ad images are well under this). */
export const MAX_AD_COVER_DOWNLOAD_BYTES = 5 * 1024 * 1024;
/** Request timeout for a cover download. */
export const COVER_FETCH_TIMEOUT_MS = 8000;
/** Auto covers refresh after this many days (also enforced in the ingestion upsert). */
export const COVER_REFRESH_DAYS = 30;
/** The reconcile only retries a queued url this fresh — past it a signed url is assumed expired. */
export const COVER_FETCH_MAX_AGE_DAYS = 2;

export type CoverUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

/** https + Meta-CDN-host allow-list. The first SSRF gate, before any network call. */
export function isAllowedCoverUrl(raw: string): CoverUrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'bad_url' };
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  const host = url.hostname.toLowerCase();
  if (!META_CDN_HOST_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
    return { ok: false, reason: 'host_not_allowed' };
  }
  return { ok: true, url };
}

/** Confirm the bytes are a png/jpeg/webp by their MAGIC BYTES (never the content-type header alone). */
export function detectCoverImage(bytes: Uint8Array): { ext: string; contentType: string } | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return { ext: 'png', contentType: 'image/png' };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}
