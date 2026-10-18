import { query } from '../client.js';

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
