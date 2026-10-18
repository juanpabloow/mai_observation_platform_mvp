import type { PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';
import { recordCrmActivity } from '../db/repositories/crmActivityEvents.js';
import {
  decideInboundOrigin,
  setContactOrigin,
  type AdSourceType,
} from '../db/repositories/attribution.js';
import { logger } from '../logger.js';

/**
 * AT-1 §3 — attribution ingestion. Turns the flat referral_* keys a Meta-ad message carries in
 * its metadata into an ad row + a touch, and sets a NEW contact's origin. Generic: nothing names
 * a business or channel.
 *
 * FAIL-SAFE: attribution is SECONDARY to the message write. The caller runs this best-effort
 * (the /messages route already stored the message and answered the bot); a failure here is
 * logged + counted, never thrown back onto the hot path. A replayed message (same message_id)
 * makes no second touch (UNIQUE(message_id) + ON CONFLICT DO NOTHING).
 */

export const REFERRAL_KEYS = [
  'referral_source_type',
  'referral_source_id',
  'referral_source_url',
  'referral_ctwa_clid',
  'referral_headline',
  'referral_body',
  'referral_media_type',
] as const;

export interface ReferralInput {
  sourceType: AdSourceType;
  sourceId: string;
  sourceUrl: string | null;
  ctwaClid: string | null;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
}

export type ParseReferralResult =
  | { present: false }
  | { present: true; ok: true; value: ReferralInput }
  | { present: true; ok: false; reason: string };

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
const cap = (v: string | null, n: number): string | null => (v == null ? null : v.slice(0, n));

/**
 * Extract + validate the referral from a message's metadata (PURE). `present: false` = not an
 * ad message (no referral keys) — not an error. `present: true, ok: false` = a referral that
 * failed validation (store the message, write no touch, count a failure). Validation:
 * source_type ∈ {ad, post}; source_id is digits OR a "TEST-" id, ≤200; other fields capped.
 */
export function parseReferral(metadata: Record<string, unknown> | null | undefined): ParseReferralResult {
  if (!metadata) return { present: false };
  const sourceId = str(metadata.referral_source_id);
  const sourceType = str(metadata.referral_source_type);
  if (!sourceId && !sourceType) return { present: false };

  if (sourceType !== 'ad' && sourceType !== 'post') {
    return { present: true, ok: false, reason: 'referral_source_type must be "ad" or "post"' };
  }
  if (!sourceId) return { present: true, ok: false, reason: 'referral_source_id is required' };
  if (sourceId.length > 200 || !(/^\d+$/.test(sourceId) || sourceId.startsWith('TEST-'))) {
    return { present: true, ok: false, reason: 'referral_source_id must be all digits or a "TEST-" id (<=200 chars)' };
  }
  return {
    present: true,
    ok: true,
    value: {
      sourceType,
      sourceId,
      sourceUrl: cap(str(metadata.referral_source_url), 2048),
      ctwaClid: cap(str(metadata.referral_ctwa_clid), 512),
      headline: cap(str(metadata.referral_headline), 500),
      body: cap(str(metadata.referral_body), 2000),
      mediaType: cap(str(metadata.referral_media_type), 50),
    },
  };
}

// ── In-memory failure counter (health signal; per-process, resets on restart) ───
let failureCount = 0;
export function recordAttributionFailure(context: Record<string, unknown>, err?: unknown): void {
  failureCount += 1;
  logger.warn({ ...context, err: err instanceof Error ? err.message : err ? String(err) : undefined }, 'AT-1: attribution failed (message write unaffected)');
}
export function getAttributionFailureCount(): number {
  return failureCount;
}

/**
 * Register/refresh the ad and insert the touch (idempotent by message_id). Writes the
 * attribution_touch timeline event when a touch is newly inserted. Runs on the given tx client.
 * Does NOT set origin or move the contact's touch pointers — the caller does (origin depends on
 * whether the contact is new/first-seen).
 */
export async function registerAdAndTouch(
  client: PoolClient,
  input: {
    tenantId: string;
    clientId: string;
    contactId: string;
    conversationId: string | null;
    messageId: string;
    occurredAt: Date;
    referral: ReferralInput;
  },
): Promise<{ adId: string; touchId: string | null }> {
  const ad = await client.query<{ id: string }>(
    `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, headline, body, source_url, media_type, first_seen_at, last_seen_at)
       VALUES ($1, $2, 'meta', $3, $4, $5, $6, $7, $8, $9, $9)
     ON CONFLICT (client_id, platform, source_type, external_id) DO UPDATE SET
       headline = COALESCE(EXCLUDED.headline, ads.headline),
       body = COALESCE(EXCLUDED.body, ads.body),
       source_url = COALESCE(EXCLUDED.source_url, ads.source_url),
       media_type = COALESCE(EXCLUDED.media_type, ads.media_type),
       first_seen_at = LEAST(ads.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(ads.last_seen_at, EXCLUDED.last_seen_at),
       updated_at = now()
     RETURNING id`,
    [input.tenantId, input.clientId, input.referral.sourceType, input.referral.sourceId,
     input.referral.headline, input.referral.body, input.referral.sourceUrl, input.referral.mediaType, input.occurredAt],
  );
  const adId = ad.rows[0]!.id;

  const touch = await client.query<{ id: string }>(
    `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, ctwa_clid, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (message_id) DO NOTHING
     RETURNING id`,
    [input.tenantId, input.clientId, input.contactId, input.conversationId, input.messageId, adId, input.referral.ctwaClid, input.occurredAt],
  );
  if (touch.rows.length === 0) return { adId, touchId: null }; // replay — a touch for this message already exists

  await recordCrmActivity(client, {
    tenantId: input.tenantId,
    clientId: input.clientId,
    contactId: input.contactId,
    eventType: 'attribution_touch',
    actorUserId: null,
    actorKind: 'automation',
    detail: { ad_id: adId, source_type: input.referral.sourceType, external_id: input.referral.sourceId },
  });
  return { adId, touchId: touch.rows[0]!.id };
}

/** Recompute a contact's latest_touch_id = its most recent touch (order-independent). */
async function refreshLatestTouch(client: PoolClient, tenantId: string, clientId: string, contactId: string): Promise<void> {
  await client.query(
    `UPDATE contacts SET latest_touch_id = (
        SELECT id FROM attribution_touches
         WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3
         ORDER BY occurred_at DESC, id DESC LIMIT 1), updated_at = now()
      WHERE id = $3 AND tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId, contactId],
  );
}

/**
 * LIVE ingestion for one inbound user message that carried a (valid) referral. Registers the ad
 * + touch, moves latest_touch, and — only when the contact was JUST created — sets its origin to
 * meta_ad/meta_post with this touch as first_touch. An existing contact's origin never changes
 * (it only gets the touch + a moved latest_touch). Transactional.
 */
export async function ingestLiveReferral(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  contactWasNew: boolean;
  conversationId: string | null;
  messageId: string;
  occurredAt: Date;
  referral: ReferralInput;
}): Promise<{ touched: boolean }> {
  return withTransaction(async (client) => {
    const { touchId } = await registerAdAndTouch(client, input);
    if (!touchId) return { touched: false }; // replay — nothing more to do
    await refreshLatestTouch(client, input.tenantId, input.clientId, input.contactId);
    if (input.contactWasNew) {
      await setContactOrigin(
        {
          tenantId: input.tenantId,
          clientId: input.clientId,
          contactId: input.contactId,
          originKind: decideInboundOrigin({ hasReferral: true, sourceType: input.referral.sourceType, atOrAfterTrackingStart: true }),
          firstTouchId: touchId,
          latestTouchId: touchId,
          setBy: 'system',
          overwritable: [],
        },
        client,
      );
    }
    return { touched: true };
  });
}
