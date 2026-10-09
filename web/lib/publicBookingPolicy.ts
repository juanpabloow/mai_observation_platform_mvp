/**
 * PUBLIC booking policy — every knob of /book/{slug} read from the environment in ONE
 * place, with safe defaults, so the routes never parse env vars themselves and a typo
 * in Railway falls back to a sane value instead of disabling a guard.
 *
 * Pure (no `server-only`, no I/O) so it is unit-testable from the root runner. Secrets
 * pass through it but are never logged or returned to a client: the only values a page
 * may forward to the browser are `turnstile.siteKey` (public by design) and
 * `privacyPolicyUrl`.
 *
 * Variables (all optional; see docs/public-booking.md):
 *   PUBLIC_BOOKING_DISABLED                     "true" → every public booking surface 404s
 *   PUBLIC_BOOKING_RATE_LIMIT_IP_MAX            attempts per IP per site per window (10)
 *   PUBLIC_BOOKING_RATE_LIMIT_IP_WINDOW_SECONDS window for the IP rule (600)
 *   PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX         attempts per phone per site per window (5)
 *   PUBLIC_BOOKING_RATE_LIMIT_PHONE_WINDOW_SECONDS window for the phone rule (3600)
 *   PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE         future active bookings per phone per site (3)
 *   PUBLIC_BOOKING_HASH_SECRET                  HMAC key for the rate-limit buckets
 *                                               (falls back to BETTER_AUTH_SECRET)
 *   PUBLIC_BOOKING_TURNSTILE_ENABLED            "true" → a Turnstile token is REQUIRED
 *   NEXT_PUBLIC_TURNSTILE_SITE_KEY              Turnstile site key (public)
 *   PUBLIC_BOOKING_TURNSTILE_SECRET_KEY         Turnstile secret (server only)
 *   PUBLIC_BOOKING_PRIVACY_POLICY_URL           absolute http(s) URL of the privacy policy
 */

export interface RateRule {
  limit: number;
  windowSec: number;
}

export interface PublicBookingPolicy {
  disabled: boolean;
  rateLimit: { ip: RateRule; phone: RateRule };
  maxActivePerPhone: number;
  /** HMAC key for rate-limit hashing; null = not configured (creation fails closed). */
  hashSecret: string | null;
  turnstile: {
    enabled: boolean;
    siteKey: string | null;
    secretKey: string | null;
  };
  privacyPolicyUrl: string | null;
}

type Env = Record<string, string | undefined>;

export const POLICY_DEFAULTS = {
  ipMax: 10,
  ipWindowSec: 600,
  phoneMax: 5,
  phoneWindowSec: 3600,
  maxActivePerPhone: 3,
} as const;

const truthy = (v: string | undefined): boolean => /^(1|true|yes|on)$/i.test((v ?? "").trim());

/** A positive integer within [min, max]; anything else → the default. */
function intIn(v: string | undefined, fallback: number, min: number, max: number): number {
  const raw = (v ?? "").trim();
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : fallback;
}

const nonEmpty = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

/** Only an absolute http(s) URL is accepted — never a relative path or `javascript:`. */
export function safeExternalUrl(v: string | undefined): string | null {
  const t = nonEmpty(v);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function readPublicBookingPolicy(env: Env = process.env): PublicBookingPolicy {
  const hash = nonEmpty(env.PUBLIC_BOOKING_HASH_SECRET) ?? nonEmpty(env.BETTER_AUTH_SECRET);
  return {
    disabled: truthy(env.PUBLIC_BOOKING_DISABLED),
    rateLimit: {
      ip: {
        limit: intIn(env.PUBLIC_BOOKING_RATE_LIMIT_IP_MAX, POLICY_DEFAULTS.ipMax, 1, 10_000),
        windowSec: intIn(env.PUBLIC_BOOKING_RATE_LIMIT_IP_WINDOW_SECONDS, POLICY_DEFAULTS.ipWindowSec, 10, 86_400),
      },
      phone: {
        limit: intIn(env.PUBLIC_BOOKING_RATE_LIMIT_PHONE_MAX, POLICY_DEFAULTS.phoneMax, 1, 10_000),
        windowSec: intIn(env.PUBLIC_BOOKING_RATE_LIMIT_PHONE_WINDOW_SECONDS, POLICY_DEFAULTS.phoneWindowSec, 10, 86_400),
      },
    },
    maxActivePerPhone: intIn(env.PUBLIC_BOOKING_MAX_ACTIVE_PER_PHONE, POLICY_DEFAULTS.maxActivePerPhone, 1, 100),
    // A short secret is as good as none — hashRateKey rejects < 16 chars too.
    hashSecret: hash && hash.length >= 16 ? hash : null,
    turnstile: {
      enabled: truthy(env.PUBLIC_BOOKING_TURNSTILE_ENABLED),
      siteKey: nonEmpty(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY),
      secretKey: nonEmpty(env.PUBLIC_BOOKING_TURNSTILE_SECRET_KEY),
    },
    privacyPolicyUrl: safeExternalUrl(env.PUBLIC_BOOKING_PRIVACY_POLICY_URL),
  };
}

/** What the booking PAGE may hand to the browser — public values only. */
export interface PublicClientConfig {
  /** Non-null only when Turnstile is enabled AND has a site key. */
  turnstileSiteKey: string | null;
  /** Enabled but misconfigured: the page says booking is unavailable instead of failing on submit. */
  turnstileMisconfigured: boolean;
  privacyPolicyUrl: string | null;
}

export function publicClientConfig(policy: PublicBookingPolicy): PublicClientConfig {
  const t = policy.turnstile;
  return {
    turnstileSiteKey: t.enabled && t.siteKey ? t.siteKey : null,
    turnstileMisconfigured: t.enabled && (!t.siteKey || !t.secretKey),
    privacyPolicyUrl: policy.privacyPolicyUrl,
  };
}
