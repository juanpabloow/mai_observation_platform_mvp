import { mapQueryFromMapsUrl, safeMapsUrl } from "./bookingPage";

/**
 * SERVER ONLY — what the booking page's map searches, so its pin is the same place the
 * business's "Cómo llegar" link opens (product, 3 Nov 2026):
 *  1. the coordinates (or place) inside the business's own Google Maps link;
 *  2. for a short link (maps.app.goo.gl), the same after following its redirects — only
 *     to Google Maps hosts (safeMapsUrl), at most 4 hops, 2.5 s, cached per link;
 *  3. else "<name>, <address>", which Google usually resolves to the business itself;
 *  4. no address and no link: no map.
 * Resolving never blocks the page for long and never fails it: any problem falls to 3.
 */

const TTL_MS = 24 * 60 * 60_000;
const FAIL_TTL_MS = 10 * 60_000;
const MAX_HOPS = 4;
const cache = new Map<string, { query: string | null; until: number }>();

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Follows a short Maps link's redirects (Google hosts only) and reads the place from it. */
export async function resolveMapsLink(url: string, fetcher: Fetcher = fetch, now = Date.now()): Promise<string | null> {
  const hit = cache.get(url);
  if (hit && hit.until > now) return hit.query;
  let current = url;
  let query: string | null = null;
  try {
    for (let hop = 0; hop < MAX_HOPS && !query; hop++) {
      const res = await fetcher(current, { method: "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(2500) });
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) break;
      const next = safeMapsUrl(new URL(location, current).toString());
      if (!next) break;
      current = next;
      query = mapQueryFromMapsUrl(current);
    }
  } catch {
    query = null;
  }
  cache.set(url, { query, until: now + (query ? TTL_MS : FAIL_TTL_MS) });
  return query;
}

export async function publicMapQuery(
  site: { name: string; address: string | null; public_maps_url?: string | null },
  fetcher: Fetcher = fetch,
): Promise<string | null> {
  const own = safeMapsUrl(site.public_maps_url ?? null);
  if (own) {
    const direct = mapQueryFromMapsUrl(own);
    if (direct) return direct;
    const resolved = await resolveMapsLink(own, fetcher);
    if (resolved) return resolved;
  }
  const address = site.address?.trim();
  return address ? `${site.name}, ${address}` : null;
}

/** Tests only. */
export function clearMapsCache(): void {
  cache.clear();
}
