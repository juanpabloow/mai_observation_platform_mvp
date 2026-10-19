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

/**
 * Classify a contact's origin from its FACTS — the SHARED rule used by the live path AND the
 * backfill, so a contact gets the SAME origin whether it was classified the moment its first
 * message arrived or in a later bulk pass. No touch dependency. (decideInboundOrigin is the
 * single-message variant; this looks at the contact's FIRST inbound message.)
 *  - first inbound message carried a referral → meta_ad / meta_post (a DURABLE fact, independent
 *    of any date — this is why an ad lead classifies correctly even before tracking is set);
 *  - no referral, created via the booking page (channel 'public') → booking_page;
 *  - no referral, first message at/after tracking_started_at → organic_whatsapp;
 *  - otherwise → unknown — an INFERENCE that couldn't be made yet (before capture, no message
 *    yet, tracking not started). It is PROVISIONAL: automation may revisit it when a fact
 *    (e.g. a corrected tracking_started_at) arrives. booked_by_contact / import are produced at
 *    creation time, never guessed here.
 */
export function classifyContactOrigin(row: {
  channel: string;
  trackingStartedAt: Date | null;
  firstMsgAt: Date | null;
  firstReferral: { sourceType: AdSourceType } | null;
}): OriginKind {
  if (row.firstReferral) return row.firstReferral.sourceType === 'post' ? 'meta_post' : 'meta_ad';
  if (row.channel === 'public') return 'booking_page';
  if (row.firstMsgAt && row.trackingStartedAt && row.firstMsgAt.getTime() >= row.trackingStartedAt.getTime()) {
    return 'organic_whatsapp';
  }
  return 'unknown';
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
   * (origin_kind IS NULL). Ingestion/backfill pass ['unknown'] so they can revisit a PROVISIONAL
   * origin (see below); the manual path passes ['unknown','import']. A CAPTURED ad origin
   * (meta_ad/meta_post) is NEVER in any caller's set, so it can never be overwritten.
   *
   * AUTOMATION GUARD: a SYSTEM write (setBy === 'system') additionally never overwrites a
   * HUMAN-set origin — it may only (re)write an unset origin or automation's OWN prior write
   * (origin_set_by NULL or 'system'). This is what lets automation REVISIT its provisional
   * 'unknown' ("couldn't tell yet") once a fact arrives — a corrected tracking_started_at, or
   * the contact's first message landing after a CRM-upsert created the row — while a person's
   * decision (a manual origin, or a human-reviewed merge) stays final. A human write (setBy =
   * a user id) is unrestricted by this guard and still honors `overwritable`.
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
  const isSystem = input.setBy === 'system';
  const exec = async (c: PoolClient): Promise<boolean> => {
    const upd = await c.query(
      `UPDATE contacts
          SET origin_kind = $4, first_touch_id = $5, latest_touch_id = $6,
              origin_ref_contact_id = COALESCE($7, origin_ref_contact_id),
              origin_set_at = now(), origin_set_by = $8, updated_at = now()
        WHERE id = $3 AND tenant_id = $1 AND client_id = $2
          AND (origin_kind IS NULL OR origin_kind = ANY($9::text[]))
          -- Automation never overwrites a human's decision (see SetContactOriginInput.overwritable).
          AND ($10::boolean = false OR origin_set_by IS NULL OR origin_set_by = 'system')
        RETURNING id`,
      [input.tenantId, input.clientId, input.contactId, input.originKind, input.firstTouchId ?? null,
       input.latestTouchId ?? null, input.originRefContactId ?? null, input.setBy, overwritable, isSystem],
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

// ── AT-2: Campaigns / Ads management + read API ─────────────────────────────────
// The read + management half the Campañas UI drives. Every query is tenant_id +
// client_id scoped. is_test ads (a "TEST-" external_id) are EXCLUDED by default
// everywhere a human sees a count; the ads list can opt them back in for the toggle.

/** An ad plus the two numbers the Ads tab shows: leads (contacts whose FIRST touch is
 *  this ad — "this ad brought them") and touches (every inbound referral on it). */
export interface AdWithStatsRow extends AdRow {
  campaign_name: string | null;
  leads: number;
  touches: number;
}

/** A campaign plus how many ads are assigned to it. */
export interface CampaignWithStatsRow extends CampaignRow {
  ad_count: number;
}

export interface CreateCampaignInput {
  tenantId: string;
  clientId: string;
  name: string;
  status?: CampaignStatus;
  startDate?: string | null;
  endDate?: string | null;
  externalCampaignId?: string | null;
  targetServiceId?: string | null;
  promotionId?: string | null;
  botBrief?: string | null;
}

export interface UpdateCampaignInput {
  name?: string;
  status?: CampaignStatus;
  startDate?: string | null;
  endDate?: string | null;
  externalCampaignId?: string | null;
  targetServiceId?: string | null;
  promotionId?: string | null;
  botBrief?: string | null;
}

/** Origin detail for the contact record's "Origen" card — the first-touch ad + its
 *  campaign, when the origin and date were set, and every touch (ad + date). Never
 *  returns ctwa_clid (it must never surface in any UI/API). */
export interface ContactOriginDetail {
  originKind: OriginKind | null;
  originSetAt: Date | null;
  originSetBy: string | null;
  ad: { id: string; externalId: string; sourceType: AdSourceType; headline: string | null } | null;
  campaign: { id: string; name: string } | null;
  touches: Array<{ id: string; occurredAt: Date; adExternalId: string; adHeadline: string | null; sourceType: AdSourceType }>;
}

/**
 * Ads detected for a client, with leads + touches, newest-seen first. Test ads
 * (is_test) are excluded unless includeTest. `campaign_name` is null when unassigned.
 */
export async function listAdsWithStats(
  tenantId: string,
  clientId: string,
  opts: { includeTest?: boolean } = {},
): Promise<AdWithStatsRow[]> {
  const r = await query<AdWithStatsRow>(
    `SELECT a.*, c.name AS campaign_name,
            (SELECT count(*)::int FROM attribution_touches t
               WHERE t.tenant_id = a.tenant_id AND t.client_id = a.client_id AND t.ad_id = a.id) AS touches,
            (SELECT count(*)::int FROM contacts ct
               JOIN attribution_touches ft ON ft.id = ct.first_touch_id
              WHERE ct.tenant_id = a.tenant_id AND ct.client_id = a.client_id AND ft.ad_id = a.id) AS leads
       FROM ads a
       LEFT JOIN campaigns c ON c.id = a.campaign_id
      WHERE a.tenant_id = $1 AND a.client_id = $2
        ${opts.includeTest ? '' : 'AND a.is_test = false'}
      ORDER BY a.last_seen_at DESC, a.id`,
    [tenantId, clientId],
  );
  return r.rows;
}

/** Real (non-test) ads with no campaign yet — the "sin configurar" nav count. */
export async function countUnconfiguredAds(tenantId: string, clientId: string): Promise<number> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ads
      WHERE tenant_id = $1 AND client_id = $2 AND campaign_id IS NULL AND is_test = false`,
    [tenantId, clientId],
  );
  return r.rows[0]?.n ?? 0;
}

/** clientId → count of real (non-test) unconfigured ads, for the whole tenant in ONE query
 *  (the sidebar "sin configurar" badge — avoids an N+1 across the agency's clients). */
export async function unconfiguredAdCountsByClient(tenantId: string): Promise<Record<string, number>> {
  const r = await query<{ client_id: string; n: number }>(
    `SELECT client_id, count(*)::int AS n FROM ads
      WHERE tenant_id = $1 AND campaign_id IS NULL AND is_test = false
      GROUP BY client_id`,
    [tenantId],
  );
  const out: Record<string, number> = {};
  for (const row of r.rows) out[row.client_id] = row.n;
  return out;
}

/** Campaigns for a client (active first, then newest), each with its assigned-ad count. */
export async function listCampaignsWithStats(tenantId: string, clientId: string): Promise<CampaignWithStatsRow[]> {
  const r = await query<CampaignWithStatsRow>(
    `SELECT c.*,
            (SELECT count(*)::int FROM ads a WHERE a.tenant_id = c.tenant_id AND a.client_id = c.client_id AND a.campaign_id = c.id) AS ad_count
       FROM campaigns c
      WHERE c.tenant_id = $1 AND c.client_id = $2
      ORDER BY (c.status = 'active') DESC, c.created_at DESC`,
    [tenantId, clientId],
  );
  return r.rows;
}

export async function createCampaign(input: CreateCampaignInput): Promise<CampaignRow> {
  const r = await query<CampaignRow>(
    `INSERT INTO campaigns (tenant_id, client_id, name, status, start_date, end_date,
                            external_campaign_id, target_service_id, promotion_id, bot_brief)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [input.tenantId, input.clientId, input.name, input.status ?? 'active', input.startDate ?? null,
     input.endDate ?? null, input.externalCampaignId ?? null, input.targetServiceId ?? null,
     input.promotionId ?? null, input.botBrief ?? null],
  );
  return r.rows[0]!;
}

/** Patch a campaign; dynamic SET, always pinned to (id, tenant_id, client_id). */
export async function updateCampaign(
  tenantId: string,
  clientId: string,
  id: string,
  patch: UpdateCampaignInput,
): Promise<CampaignRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId, clientId];
  const add = (col: string, val: unknown) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.startDate !== undefined) add('start_date', patch.startDate);
  if (patch.endDate !== undefined) add('end_date', patch.endDate);
  if (patch.externalCampaignId !== undefined) add('external_campaign_id', patch.externalCampaignId);
  if (patch.targetServiceId !== undefined) add('target_service_id', patch.targetServiceId);
  if (patch.promotionId !== undefined) add('promotion_id', patch.promotionId);
  if (patch.botBrief !== undefined) add('bot_brief', patch.botBrief);
  if (sets.length === 0) return getCampaignById(tenantId, clientId, id);
  sets.push('updated_at = now()');
  const r = await query<CampaignRow>(
    `UPDATE campaigns SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

/** End a campaign: status='ended', end_date defaulted to today when not already set. */
export async function endCampaign(tenantId: string, clientId: string, id: string): Promise<CampaignRow | null> {
  const r = await query<CampaignRow>(
    `UPDATE campaigns SET status = 'ended', end_date = COALESCE(end_date, current_date), updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
    [id, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/**
 * Assign (or clear, with campaignId null) the campaign of one or more ads. The caller
 * validates that campaignId belongs to this client. Returns the number of ads changed.
 */
export async function assignAdsToCampaign(
  tenantId: string,
  clientId: string,
  adIds: string[],
  campaignId: string | null,
): Promise<number> {
  if (adIds.length === 0) return 0;
  const r = await query(
    `UPDATE ads SET campaign_id = $4, updated_at = now()
      WHERE tenant_id = $1 AND client_id = $2 AND id = ANY($3::uuid[])`,
    [tenantId, clientId, adIds, campaignId],
  );
  return r.rowCount ?? 0;
}

/** The contact record's origin detail (first-touch ad + campaign + every touch). */
export async function getContactOriginDetail(
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<ContactOriginDetail | null> {
  const head = await query<{
    origin_kind: OriginKind | null; origin_set_at: Date | null; origin_set_by: string | null;
    ad_id: string | null; external_id: string | null; source_type: AdSourceType | null; headline: string | null;
    campaign_id: string | null; campaign_name: string | null;
  }>(
    `SELECT ct.origin_kind, ct.origin_set_at, ct.origin_set_by,
            a.id AS ad_id, a.external_id, a.source_type, a.headline,
            c.id AS campaign_id, c.name AS campaign_name
       FROM contacts ct
       LEFT JOIN attribution_touches ft ON ft.id = ct.first_touch_id
       LEFT JOIN ads a ON a.id = ft.ad_id
       LEFT JOIN campaigns c ON c.id = a.campaign_id
      WHERE ct.id = $1 AND ct.tenant_id = $2 AND ct.client_id = $3`,
    [contactId, tenantId, clientId],
  );
  const row = head.rows[0];
  if (!row) return null;
  const touchesR = await query<{ id: string; occurred_at: Date; external_id: string; headline: string | null; source_type: AdSourceType }>(
    `SELECT t.id, t.occurred_at, a.external_id, a.headline, a.source_type
       FROM attribution_touches t JOIN ads a ON a.id = t.ad_id
      WHERE t.tenant_id = $1 AND t.client_id = $2 AND t.contact_id = $3
      ORDER BY t.occurred_at ASC, t.id ASC`,
    [tenantId, clientId, contactId],
  );
  return {
    originKind: row.origin_kind,
    originSetAt: row.origin_set_at,
    originSetBy: row.origin_set_by,
    ad: row.ad_id ? { id: row.ad_id, externalId: row.external_id!, sourceType: row.source_type!, headline: row.headline } : null,
    campaign: row.campaign_id ? { id: row.campaign_id, name: row.campaign_name! } : null,
    touches: touchesR.rows.map((t) => ({
      id: t.id, occurredAt: t.occurred_at, adExternalId: t.external_id, adHeadline: t.headline, sourceType: t.source_type,
    })),
  };
}
