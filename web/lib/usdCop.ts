import "server-only";
import { parseEnvRate, parseTrmResponse, TRM_URL, type UsdCop } from "@worker/analytics/usdCop.js";

/**
 * COSTOS DE IA — today's COP/USD for the screen and the report, SERVER ONLY.
 *
 * Why this is safe for the page:
 *   - The browser never talks to the TRM service: the server fetches a FIXED URL (no part of it
 *     comes from the request), so there is no SSRF surface and the page's CSP is unchanged.
 *   - 3 s timeout, no redirects, no credentials or cookies sent, JSON only; the value must be a
 *     number inside a plausible band or it is ignored (parseTrmResponse).
 *   - One request per process every 6 h at most (in-memory cache, shared in-flight promise);
 *     a failure is remembered for 10 min so a slow upstream can't be hammered or slow pages.
 *   - Any failure falls back to the last good TRM, then to USD_COP_RATE, then to «no COP».
 *     A page never fails because the rate couldn't be fetched.
 */

const OK_TTL_MS = 6 * 60 * 60 * 1000;
const FAIL_TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 3000;

let lastGood: UsdCop | null = null;
let cache: { value: UsdCop | null; until: number } | null = null;
let inflight: Promise<UsdCop | null> | null = null;

async function fetchTrm(): Promise<UsdCop | null> {
  try {
    const res = await fetch(TRM_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return parseTrmResponse(await res.json());
  } catch {
    return null; // timeout, network, redirect or bad JSON: treated the same — no rate
  }
}

export async function getUsdCop(now = Date.now()): Promise<UsdCop | null> {
  if (process.env.USD_COP_SOURCE === "manual") return parseEnvRate(process.env.USD_COP_RATE);
  if (cache && cache.until > now) return cache.value ?? lastGood ?? parseEnvRate(process.env.USD_COP_RATE);
  inflight ??= fetchTrm().finally(() => {
    inflight = null;
  });
  const trm = await inflight;
  if (trm) lastGood = trm;
  cache = { value: trm, until: now + (trm ? OK_TTL_MS : FAIL_TTL_MS) };
  return trm ?? lastGood ?? parseEnvRate(process.env.USD_COP_RATE);
}
