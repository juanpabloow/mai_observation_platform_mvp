import type { PoolClient } from 'pg';
import { query, withTransaction } from '../client.js';
import { recordCrmActivity } from './crmActivityEvents.js';

/**
 * Attribution repository (AT-1) — lead origin as a FACT. Tenant_id + client_id scoped like
 * every domain repo; both predicates on every query. Ingestion WRITES (register ad, record
 * touch, set origin) are added in AT-1 §3; this module (§1) holds the row types and the
 * per-client tracking-start setting.
 */

/** Closed set — mirrors the contacts.origin_kind CHECK. */
export type OriginKind =
  | 'meta_ad'
  | 'meta_post'
  | 'organic_whatsapp'
  | 'booking_page'
  | 'booked_by_contact'
  | 'import'
  | 'manual'
  | 'unknown';

export type AdPlatform = 'meta';
export type AdSourceType = 'ad' | 'post';
export type CampaignStatus = 'active' | 'paused' | 'ended';

export interface AdRow {
  id: string;
  tenant_id: string;
  client_id: string;
  platform: AdPlatform;
  source_type: AdSourceType;
  external_id: string;
  headline: string | null;
  body: string | null;
  source_url: string | null;
  media_type: string | null;
  campaign_id: string | null;
  /** DERIVED (generated) from a "TEST-" external_id prefix — test ads never count by default. */
  is_test: boolean;
  first_seen_at: Date;
  last_seen_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface AttributionTouchRow {
  id: string;
  tenant_id: string;
  client_id: string;
  contact_id: string;
  conversation_id: string | null;
  message_id: string;
  ad_id: string;
  /** Meta's click id — stored because it cannot be recovered later (future Conversions API).
   *  NEVER shown in any UI or returned by any API in this arc. */
  ctwa_clid: string | null;
  occurred_at: Date;
  created_at: Date;
}

export interface CampaignRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  status: CampaignStatus;
  start_date: string | null;
  end_date: string | null;
  external_campaign_id: string | null;
  target_service_id: string | null;
  promotion_id: string | null;
  bot_brief: string | null;
  created_at: Date;
  updated_at: Date;
}

// ── Per-client tracking-start setting ──────────────────────────────────────────
// Lives OUTSIDE client_modules: capture runs regardless of the (off-by-default) campaigns
// module, so the date that makes "no referral before it proves nothing" must not be
// module-gated. A missing row = tracking not started (every no-referral contact is 'unknown').

export async function getAttributionTrackingStartedAt(tenantId: string, clientId: string): Promise<Date | null> {
  const r = await query<{ tracking_started_at: Date | null }>(
    `SELECT tracking_started_at FROM attribution_settings WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  return r.rows[0]?.tracking_started_at ?? null;
}

/** Upsert the per-client tracking start (agency-only; the web action enforces the role). */
export async function setAttributionTrackingStartedAt(
  tenantId: string,
  clientId: string,
  at: Date | null,
): Promise<void> {
  await query(
    `INSERT INTO attribution_settings (tenant_id, client_id, tracking_started_at)
       VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, client_id)
       DO UPDATE SET tracking_started_at = EXCLUDED.tracking_started_at, updated_at = now()`,
    [tenantId, clientId, at],
  );
}

/** An ad owned by this client, or null. */
export async function getAdById(tenantId: string, clientId: string, id: string): Promise<AdRow | null> {
  const r = await query<AdRow>(`SELECT * FROM ads WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [id, tenantId, clientId]);
  return r.rows[0] ?? null;
}

/** A campaign owned by this client, or null. */
export async function getCampaignById(tenantId: string, clientId: string, id: string): Promise<CampaignRow | null> {
  const r = await query<CampaignRow>(`SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [id, tenantId, clientId]);
  return r.rows[0] ?? null;
}

/**
 * Count of inbound user messages that carry a referral, have a linked contact, but no touch yet
 * — the reconciliation backlog and the health signal. Scoped to a tenant (the health endpoint's).
 */
export async function countPendingAttributions(tenantId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM handoff_messages m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN attribution_touches t ON t.message_id = m.id
      WHERE m.tenant_id = $1 AND m.sender = 'user'
        AND m.metadata ? 'referral_source_id'
        AND c.contact_id IS NOT NULL AND t.id IS NULL`,
    [tenantId],
  );
  return r.rows[0]?.n ?? 0;
}

// ── Origin rules (AT-1 §2) — facts only, never inference ────────────────────────

/**
 * The origin of a contact created from an INBOUND message (pure, unit-testable):
 *  - carried a referral → meta_ad / meta_post (the fact: an ad/post brought them);
 *  - no referral, first message at/after tracking start → organic_whatsapp;
 *  - no referral, before tracking start (or tracking never started) → unknown — the absence
 *    of a referral proves nothing before capture began.
 */
export function decideInboundOrigin(input: {
  hasReferral: boolean;
  sourceType?: AdSourceType | null;
  atOrAfterTrackingStart: boolean;
}): OriginKind {
  if (input.hasReferral) return input.sourceType === 'post' ? 'meta_post' : 'meta_ad';
  return input.atOrAfterTrackingStart ? 'organic_whatsapp' : 'unknown';
}

export interface SetContactOriginInput {
  tenantId: string;
  clientId: string;
  contactId: string;
  originKind: OriginKind;
  firstTouchId?: string | null;
  latestTouchId?: string | null;
  originRefContactId?: string | null;
  /** 'system' for automation, or the acting user id. */
  setBy: string;
  /** A free-text manual note (manual origin only). */
  note?: string | null;
  /** Optional ad/campaign the operator points a manual origin at (recorded in the event). */
  refAdId?: string | null;
  refCampaignId?: string | null;
  /**
   * Which existing origins this assignment may REPLACE. Default [] = only an UNSET origin
   * (origin_kind IS NULL) — the ingestion case ("set origin if the contact is new"). The
   * manual path passes ['unknown','import']. A CAPTURED ad origin is NEVER in this set, so it
   * can never be overwritten.
   */
  overwritable?: OriginKind[];
}

/**
 * Set a contact's origin WITH provenance, and write the origin_set timeline event — both in
 * one transaction. Returns true if it set, false if the current origin was outside
 * `overwritable` (so a captured ad origin is never silently rewritten). Pass a `client` to run
 * inside a caller's transaction (ingestion/booking); omit it to self-transact.
 */
export async function setContactOrigin(input: SetContactOriginInput, client?: PoolClient): Promise<boolean> {
  const overwritable = input.overwritable ?? [];
  const exec = async (c: PoolClient): Promise<boolean> => {
    const upd = await c.query(
      `UPDATE contacts
          SET origin_kind = $4, first_touch_id = $5, latest_touch_id = $6,
              origin_ref_contact_id = COALESCE($7, origin_ref_contact_id),
              origin_set_at = now(), origin_set_by = $8, updated_at = now()
        WHERE id = $3 AND tenant_id = $1 AND client_id = $2
          AND (origin_kind IS NULL OR origin_kind = ANY($9::text[]))
        RETURNING id`,
      [input.tenantId, input.clientId, input.contactId, input.originKind, input.firstTouchId ?? null,
       input.latestTouchId ?? null, input.originRefContactId ?? null, input.setBy, overwritable],
    );
    if ((upd.rowCount ?? 0) === 0) return false; // captured origin present → never overwrite
    await recordCrmActivity(c, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: input.contactId,
      eventType: 'origin_set',
      actorUserId: input.setBy === 'system' ? null : input.setBy,
      actorKind: input.setBy === 'system' ? 'automation' : 'user',
      detail: {
        origin_kind: input.originKind,
        ...(input.firstTouchId ? { first_touch_id: input.firstTouchId } : {}),
        ...(input.originRefContactId ? { origin_ref_contact_id: input.originRefContactId } : {}),
        ...(input.refAdId ? { ad_id: input.refAdId } : {}),
        ...(input.refCampaignId ? { campaign_id: input.refCampaignId } : {}),
        ...(input.note ? { note: input.note } : {}),
      },
    });
    return true;
  };
  return client ? exec(client) : withTransaction(exec);
}
