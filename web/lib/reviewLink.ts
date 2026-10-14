import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * REVIEW LINKS — `/resena/{token}`, one per completed appointment.
 *
 * token = base64url(review id, 16 bytes) "." base64url(HMAC-SHA256(secret, "review-link:v1:" + id))[0..32]
 *
 * Nothing secret is stored: the row id travels in the link and the signature proves the
 * platform issued it, so the same link can be copied again later (agenda, n8n) and stays
 * the same. Rotating the secret invalidates every outstanding link — by design.
 *
 * Secret: REVIEW_LINK_SECRET, else PUBLIC_BOOKING_HASH_SECRET, else BETTER_AUTH_SECRET
 * (≥ 16 characters, the same rule as the public booking hasher). Without one, links are
 * neither issued nor accepted (fail closed). Server-side only.
 */

const MIN_SECRET = 16;
const SIG_LEN = 32;

export function reviewLinkSecret(env: Record<string, string | undefined> = process.env): string | null {
  for (const v of [env.REVIEW_LINK_SECRET, env.PUBLIC_BOOKING_HASH_SECRET, env.BETTER_AUTH_SECRET]) {
    const t = (v ?? "").trim();
    if (t.length >= MIN_SECRET) return t;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idToBytes(id: string): Buffer {
  return Buffer.from(id.replace(/-/g, ""), "hex");
}
function bytesToId(b: Buffer): string {
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function signature(secret: string, id: string): string {
  return createHmac("sha256", secret).update(`review-link:v1:${id.toLowerCase()}`).digest("base64url").slice(0, SIG_LEN);
}

export function signReviewToken(reviewId: string, secret: string): string {
  if (!UUID_RE.test(reviewId)) throw new Error("review id must be a uuid");
  return `${idToBytes(reviewId).toString("base64url")}.${signature(secret, reviewId)}`;
}

/** The review id when the token is well-formed AND signed by `secret`; null otherwise. */
export function verifyReviewToken(token: string, secret: string): string | null {
  if (typeof token !== "string" || token.length > 80) return null;
  const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return null;
  const bytes = Buffer.from(m[1], "base64url");
  if (bytes.length !== 16) return null;
  const id = bytesToId(bytes);
  const expected = Buffer.from(signature(secret, id));
  const given = Buffer.from(m[2]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return id;
}

export function reviewPath(token: string): string {
  return `/resena/${token}`;
}
