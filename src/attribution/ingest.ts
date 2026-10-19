import type { PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';
import { recordCrmActivity } from '../db/repositories/crmActivityEvents.js';
import {
  classifyContactOrigin,
  setContactOrigin,
  type AdSourceType,
} from '../db/repositories/attribution.js';
import { logger } from '../logger.js';

/**
 * AT-1 §3 — attribution ingestion. Turns the flat referral_* keys a Meta-ad message carries in
 * its metadata into an ad row + a touch (ingestLiveReferral), and sets a contact's origin from
 * its FIRST inbound message (ensureInboundOrigin). Generic: nothing names a business or channel.
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
 * LIVE ingestion for one inbound user message that carried a (valid) referral: register the ad +
 * insert the touch (idempotent by message_id) and move latest_touch. Does NOT set the contact's
 * origin — that is ensureInboundOrigin's job. Origin is decided by the contact's FIRST inbound
 * message (which may not be THIS one) and must be set regardless of which path created the contact
 * row, so it cannot be gated on "this message created the contact." Transactional.
 */
export async function ingestLiveReferral(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  conversationId: string | null;
  messageId: string;
  occurredAt: Date;
  referral: ReferralInput;
}): Promise<{ touched: boolean }> {
  return withTransaction(async (client) => {
    const { touchId } = await registerAdAndTouch(client, input);
    if (!touchId) return { touched: false }; // replay — nothing more to do
    await refreshLatestTouch(client, input.tenantId, input.clientId, input.contactId);
    return { touched: true };
  });
}

/**
 * LIVE origin, as a FACT: ensure a contact's origin reflects its FIRST inbound user message —
 * WHATEVER path created the row. A CRM /contacts/upsert "sync profile" node commonly creates the
 * contact a moment BEFORE its first message arrives, so the contact is already "existing" when the
 * message lands; gating origin on "the message created the contact" left exactly those at NULL
 * (organic) or let a provisional 'unknown' freeze. This keys off the contact instead.
 *
 * Idempotent + self-healing. It only (re)writes a PROVISIONAL origin — unset, or an automation-set
 * 'unknown' ("couldn't tell yet") — never a positive captured origin (meta_ad, organic_whatsapp,
 * booking_page, …) and never a human's choice (setContactOrigin's automation guard also enforces
 * this at write time, so it is race-safe). Classifies from the contact's EARLIEST inbound user
 * message via the shared classifyContactOrigin (referral → meta_ad/meta_post with that touch as
 * first_touch; none, at/after tracking start → organic_whatsapp; before → unknown). Safe to call on
 * ANY inbound message — a settled origin short-circuits. Own transaction; the caller runs it
 * best-effort (never on the message's hot path).
 */
export async function ensureInboundOrigin(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
}): Promise<{ set: boolean }> {
  return withTransaction(async (client) => {
    const ctx = await client.query<{
      channel: string;
      origin_kind: string | null;
      origin_set_by: string | null;
      tracking_started_at: Date | null;
      first_msg_at: Date | null;
      first_msg_metadata: Record<string, unknown> | null;
    }>(
      `SELECT ct.channel, ct.origin_kind, ct.origin_set_by, s.tracking_started_at,
              fm.occurred_at AS first_msg_at, fm.metadata AS first_msg_metadata
         FROM contacts ct
         LEFT JOIN attribution_settings s ON s.tenant_id = ct.tenant_id AND s.client_id = ct.client_id
         LEFT JOIN LATERAL (
           SELECT m.occurred_at, m.metadata
             FROM handoff_messages m
             JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.contact_id = ct.id AND m.sender = 'user'
            ORDER BY m.occurred_at ASC, m.id ASC LIMIT 1) fm ON true
        WHERE ct.id = $1 AND ct.tenant_id = $2 AND ct.client_id = $3`,
      [input.contactId, input.tenantId, input.clientId],
    );
    const row = ctx.rows[0];
    if (!row) return { set: false };
    // Only a PROVISIONAL origin is revisited: unset, or automation's OWN 'unknown'. A positive
    // origin or anything a person set is final (setContactOrigin would refuse it regardless).
    const provisional =
      row.origin_kind === null ||
      (row.origin_kind === 'unknown' && (row.origin_set_by === null || row.origin_set_by === 'system'));
    if (!provisional) return { set: false };

    const parsed = parseReferral(row.first_msg_metadata);
    const firstReferral = parsed.present && parsed.ok ? parsed.value : null;
    const origin = classifyContactOrigin({
      channel: row.channel,
      trackingStartedAt: row.tracking_started_at,
      firstMsgAt: row.first_msg_at,
      firstReferral,
    });
    if (origin === row.origin_kind) return { set: false }; // e.g. 'unknown' → 'unknown': no churn

    let firstTouchId: string | null = null;
    let latestTouchId: string | null = null;
    if (origin === 'meta_ad' || origin === 'meta_post') {
      firstTouchId = (await client.query<{ id: string }>(
        `SELECT id FROM attribution_touches WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3 ORDER BY occurred_at ASC, id ASC LIMIT 1`,
        [input.tenantId, input.clientId, input.contactId])).rows[0]?.id ?? null;
      latestTouchId = (await client.query<{ id: string }>(
        `SELECT id FROM attribution_touches WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [input.tenantId, input.clientId, input.contactId])).rows[0]?.id ?? null;
    }
    const set = await setContactOrigin(
      {
        tenantId: input.tenantId,
        clientId: input.clientId,
        contactId: input.contactId,
        originKind: origin,
        firstTouchId,
        latestTouchId,
        setBy: 'system',
        overwritable: ['unknown'],
      },
      client,
    );
    return { set };
  });
}
