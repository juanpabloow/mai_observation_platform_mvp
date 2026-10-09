/**
 * Cloudflare Turnstile — SERVER-SIDE verification of the token the booking page's
 * widget produced. The browser's own "I passed" is never trusted: only Cloudflare's
 * siteverify answer, fetched here with our secret, decides.
 *
 * Fail closed: a missing secret/token, a non-2xx, malformed JSON, a timeout, or any
 * `success !== true` is a rejection. Single-use is enforced by Cloudflare itself — a
 * replayed token comes back `timeout-or-duplicate`. The optional `idempotencyKey`
 * (a UUID, the booking's Idempotency-Key) lets a network-level RETRY of the SAME
 * booking re-verify the SAME token without being treated as a replay; a different
 * booking can't reuse it, because one Idempotency-Key creates at most one appointment.
 *
 * The token and the secret are never logged or echoed. Pure apart from the injected
 * `fetchImpl`, so it is unit-testable without the network.
 */

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** The widget renders with this action; a token minted for another action is refused. */
export const TURNSTILE_ACTION = "public_booking";
/** Cloudflare documents tokens up to 2048 characters. */
export const TURNSTILE_TOKEN_MAX = 2048;

export type TurnstileOutcome =
  | { ok: true }
  | { ok: false; reason: "missing_secret" | "missing_token" | "invalid" | "unavailable" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function verifyTurnstileToken(input: {
  secret: string | null;
  token: unknown;
  remoteIp?: string | null;
  idempotencyKey?: string | null;
  expectedAction?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<TurnstileOutcome> {
  if (!input.secret) return { ok: false, reason: "missing_secret" };
  const token = typeof input.token === "string" ? input.token.trim() : "";
  if (!token || token.length > TURNSTILE_TOKEN_MAX) return { ok: false, reason: "missing_token" };

  const body = new URLSearchParams({ secret: input.secret, response: token });
  if (input.remoteIp && input.remoteIp !== "unknown") body.set("remoteip", input.remoteIp);
  if (input.idempotencyKey && UUID_RE.test(input.idempotencyKey)) body.set("idempotency_key", input.idempotencyKey);

  const doFetch = input.fetchImpl ?? fetch;
  let data: unknown;
  try {
    const res = await doFetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(input.timeoutMs ?? 5000),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, reason: "unavailable" };
    data = await res.json();
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  if (!data || typeof data !== "object") return { ok: false, reason: "unavailable" };
  const d = data as { success?: unknown; action?: unknown };
  if (d.success !== true) return { ok: false, reason: "invalid" };
  const expected = input.expectedAction === undefined ? TURNSTILE_ACTION : input.expectedAction;
  // A token minted for ANOTHER action of the same site key is refused. An empty action
  // (Cloudflare's dummy test keys) carries no claim either way.
  if (expected && typeof d.action === "string" && d.action !== "" && d.action !== expected) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true };
}
