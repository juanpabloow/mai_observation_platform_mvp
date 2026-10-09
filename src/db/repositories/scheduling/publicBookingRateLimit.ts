import { createHmac } from 'node:crypto';
import { query } from '../../client.js';

/**
 * PERSISTENT fixed-window rate limit for public booking creation, shared by every web
 * instance through PostgreSQL (table public_booking_rate_buckets, migration
 * 1784500000000). Complements — does not replace — the per-process in-memory limiter
 * the public READ endpoints keep using.
 *
 * Privacy: callers pass the raw IP / phone; this module only ever persists
 * `hashRateKey(...)` — an HMAC-SHA256 keyed by a server secret and bound to the scope
 * and the site, so the same phone hashes differently at two sites and the column can't
 * be reversed by enumerating the IPv4 / phone space.
 *
 * Atomicity: one INSERT … ON CONFLICT DO UPDATE … RETURNING per attempt, so two
 * concurrent requests can never both read "9" and both write "10".
 *
 * Scope: every statement is filtered by site (and the insert proves tenant + client
 * through the composite FK) — there is no unscoped sweep.
 */

export type RateScope = 'ip' | 'phone';

export interface RateRule {
  /** Attempts allowed per window (inclusive). */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface ConsumeInput {
  tenantId: string;
  clientId: string;
  siteId: string;
  scope: RateScope;
  /** Already hashed with hashRateKey — never the raw IP / phone. */
  keyHash: string;
  rule: RateRule;
  now?: Date;
}

export interface ConsumeResult {
  allowed: boolean;
  hits: number;
  /** Seconds until the current window closes (for Retry-After). */
  retryAfterSec: number;
}

/** HMAC-SHA256 hex of the (scope, site, value) triple. Throws on a missing secret so a
 * misconfigured deployment fails CLOSED instead of storing a guessable plain hash. */
export function hashRateKey(secret: string, scope: RateScope, siteId: string, value: string): string {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('public booking rate limit: hashing secret is missing or too short');
  }
  return createHmac('sha256', secret).update(`${scope}\u0000${siteId}\u0000${value}`).digest('hex');
}

/** Start of the fixed window containing `now` (epoch-aligned, so every instance agrees). */
export function windowStartFor(now: Date, windowSec: number): Date {
  const ms = windowSec * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

/**
 * Count one attempt and say whether it is within the rule. The attempt is counted even
 * when it is rejected, so hammering a full bucket keeps it full until the window ends.
 */
export async function consumeRateBucket(input: ConsumeInput): Promise<ConsumeResult> {
  const now = input.now ?? new Date();
  const start = windowStartFor(now, input.rule.windowSec);
  const expires = new Date(start.getTime() + input.rule.windowSec * 1000);
  const r = await query<{ hits: number }>(
    `INSERT INTO public_booking_rate_buckets
        (tenant_id, client_id, site_id, scope, key_hash, window_start, hits, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7)
     ON CONFLICT (site_id, scope, key_hash, window_start)
       DO UPDATE SET hits = public_booking_rate_buckets.hits + 1
     RETURNING hits`,
    [input.tenantId, input.clientId, input.siteId, input.scope, input.keyHash, start, expires],
  );
  const hits = r.rows[0]?.hits ?? Number.MAX_SAFE_INTEGER;
  return {
    allowed: hits <= input.rule.limit,
    hits,
    retryAfterSec: Math.max(1, Math.ceil((expires.getTime() - now.getTime()) / 1000)),
  };
}

/**
 * Remove this site's expired buckets. Bounded (at most `max` rows per call) so a sweep
 * piggy-backed on a request can never turn into a long-running delete.
 */
export async function sweepExpiredRateBuckets(
  tenantId: string,
  siteId: string,
  now: Date = new Date(),
  max = 500,
): Promise<number> {
  const r = await query(
    `DELETE FROM public_booking_rate_buckets
      WHERE ctid IN (
        SELECT ctid FROM public_booking_rate_buckets
         WHERE tenant_id = $1 AND site_id = $2 AND expires_at <= $3
         LIMIT $4
      )`,
    [tenantId, siteId, now, max],
  );
  return r.rowCount ?? 0;
}
