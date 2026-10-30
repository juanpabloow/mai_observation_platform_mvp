import type { PoolClient } from 'pg';
import { query } from '../client.js';
import type { OriginKind } from './attribution.js';

/**
 * SALES PIPELINE repository (PL-1 §1) — the DATA layer for opportunities. Tenant_id + client_id
 * scoped like every domain repo; both predicates on every query. This module holds the row types,
 * the per-client settings (with safe defaults), and the read helpers. The automatic RULES that
 * compose these (open / reopen / qualify / mark-lost / booking + appointment transitions) live in
 * the engine (PL-1 §2, `src/pipeline/`), which writes each change + its stage event in one
 * transaction. Nothing here names a business, vertical or channel.
 */

/** A sale's lifecycle status. */
export type OpportunityStatus = 'open' | 'won' | 'lost';
/** A sale's funnel position. `paid` exists but is written only by a later payments phase. */
export type OpportunityStage = 'lead' | 'qualified' | 'booked' | 'attended' | 'paid';
/** Why a sale was lost. `lost_note` is required when `otro`. */
export type LostReason = 'precio' | 'horario' | 'no_respondio' | 'no_asistio' | 'otro';

export interface OpportunityRow {
  id: string;
  tenant_id: string;
  client_id: string;
  contact_id: string;
  conversation_id: string | null;
  status: OpportunityStatus;
  stage: OpportunityStage;
  lead_at: Date | null;
  qualified_at: Date | null;
  booked_at: Date | null;
  attended_at: Date | null;
  paid_at: Date | null;
  origin_touch_id: string | null;
  qualified_by: string | null;
  qualification_service: string | null;
  qualification_timeframe: string | null;
  qualification_message_id: string | null;
  qualified_implicitly: boolean;
  lost_reason: LostReason | null;
  lost_note: string | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OpportunityStageEventRow {
  id: string;
  tenant_id: string;
  client_id: string;
  opportunity_id: string;
  from_stage: OpportunityStage | null;
  to_stage: OpportunityStage | null;
  from_status: OpportunityStatus | null;
  to_status: OpportunityStatus | null;
  actor: string;
  reason: string | null;
  occurred_at: Date;
  created_at: Date;
}

export interface PipelineSettings {
  auto_lost_after_hours: number;
  reopen_window_days: number;
}

/** Column defaults — mirror the migration's `pipeline_settings` DEFAULTs, used when a row is absent. */
export const PIPELINE_SETTINGS_DEFAULTS: PipelineSettings = {
  auto_lost_after_hours: 72,
  reopen_window_days: 30,
};

const OPP_COLUMNS = `
  id, tenant_id, client_id, contact_id, conversation_id, status, stage,
  lead_at, qualified_at, booked_at, attended_at, paid_at, origin_touch_id,
  qualified_by, qualification_service, qualification_timeframe, qualification_message_id,
  qualified_implicitly, lost_reason, lost_note, closed_at, created_at, updated_at`;

const runner = (client?: PoolClient) =>
  client ? <T extends import('pg').QueryResultRow>(sql: string, p: unknown[]) => client.query<T>(sql, p) : query;

/**
 * Per-client pipeline settings, falling back to the column defaults when no row exists. (The
 * migration seeds every existing client, so this COALESCE is belt-and-suspenders for a client
 * created outside that seed.)
 */
export async function getPipelineSettings(tenantId: string, clientId: string, client?: PoolClient): Promise<PipelineSettings> {
  const r = await runner(client)<PipelineSettings>(
    `SELECT auto_lost_after_hours, reopen_window_days FROM pipeline_settings WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  return r.rows[0] ?? { ...PIPELINE_SETTINGS_DEFAULTS };
}

/** Upsert a client's pipeline settings (PL-2 agency UI). Bounds are enforced by the DB CHECKs. */
export async function setPipelineSettings(
  tenantId: string,
  clientId: string,
  patch: Partial<PipelineSettings>,
): Promise<PipelineSettings> {
  const r = await query<PipelineSettings>(
    `INSERT INTO pipeline_settings (tenant_id, client_id, auto_lost_after_hours, reopen_window_days)
       VALUES ($1, $2, COALESCE($3, ${PIPELINE_SETTINGS_DEFAULTS.auto_lost_after_hours}), COALESCE($4, ${PIPELINE_SETTINGS_DEFAULTS.reopen_window_days}))
     ON CONFLICT (tenant_id, client_id) DO UPDATE
       SET auto_lost_after_hours = COALESCE($3, pipeline_settings.auto_lost_after_hours),
           reopen_window_days = COALESCE($4, pipeline_settings.reopen_window_days),
           updated_at = now()
     RETURNING auto_lost_after_hours, reopen_window_days`,
    [tenantId, clientId, patch.auto_lost_after_hours ?? null, patch.reopen_window_days ?? null],
  );
  return r.rows[0]!;
}

export async function getOpportunityById(tenantId: string, clientId: string, id: string, client?: PoolClient): Promise<OpportunityRow | null> {
  const r = await runner(client)<OpportunityRow>(
    `SELECT ${OPP_COLUMNS} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [id, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

/** The contact's single OPEN opportunity (the partial unique index guarantees at most one), or null. */
export async function getOpenOpportunityForContact(tenantId: string, clientId: string, contactId: string, client?: PoolClient): Promise<OpportunityRow | null> {
  const r = await runner(client)<OpportunityRow>(
    `SELECT ${OPP_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3 AND status = 'open'
      LIMIT 1`,
    [tenantId, clientId, contactId],
  );
  return r.rows[0] ?? null;
}

/** The contact's MOST RECENT opportunity regardless of status (for the reopen decision). */
export async function getLatestOpportunityForContact(tenantId: string, clientId: string, contactId: string, client?: PoolClient): Promise<OpportunityRow | null> {
  const r = await runner(client)<OpportunityRow>(
    `SELECT ${OPP_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [tenantId, clientId, contactId],
  );
  return r.rows[0] ?? null;
}

export async function listOpportunityStageEvents(tenantId: string, opportunityId: string): Promise<OpportunityStageEventRow[]> {
  const r = await query<OpportunityStageEventRow>(
    `SELECT id, tenant_id, client_id, opportunity_id, from_stage, to_stage, from_status, to_status, actor, reason, occurred_at, created_at
       FROM opportunity_stage_events
      WHERE tenant_id = $1 AND opportunity_id = $2
      ORDER BY occurred_at ASC, id ASC`,
    [tenantId, opportunityId],
  );
  return r.rows;
}

// ── PL-2 board / queue / contact reads ─────────────────────────────────────────────

/** A board card: the opportunity + the contact, its origin (via first touch), and the conversation's
 *  last message. All 1:1 joins + one LATERAL (no N+1). `stage_since` is the CURRENT stage's timestamp. */
export interface BoardOpportunityRow {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  status: OpportunityStatus;
  stage: OpportunityStage;
  created_at: Date;
  stage_since: Date | null;
  lost_reason: LostReason | null;
  lost_note: string | null;
  closed_at: Date | null;
  contact_name: string | null;
  contact_channel_user_id: string | null;
  contact_phone_e164: string | null;
  origin_kind: OriginKind | null;
  ad_name: string | null;
  ad_headline: string | null;
  ad_is_test: boolean | null;
  campaign_name: string | null;
  last_sender: string | null;
  last_message_at: Date | null;
  /** JP-6: the recorded payment of this sale (via its appointments). Amount + method only — NEVER
   *  commission. `paid_method` is null when the sale has more than one recorded payment. */
  paid_total: string | null;
  paid_method: string | null;
  // ── JP-7: the next thing to know, per stage (one batched query — no N+1) ──
  /** Lead: a preview of the conversation's last message. */
  last_message_text: string | null;
  /** Calificado: the qualification evidence + who qualified it (raw actor + resolved user name). */
  qualification_service: string | null;
  qualification_timeframe: string | null;
  qualified_by: string | null;
  qualified_by_name: string | null;
  /** Reservó / Asistió: the sale's most recent non-cancelled appointment (time, status, list price). */
  appt_start_at: Date | null;
  appt_status: string | null;
  /** The appointment's site timezone (so the card formats its time correctly). */
  appt_tz: string | null;
  /** The appointment's list price (price_snapshot) — only for a viewer with payments.view. */
  appt_list_price: string | null;
  /** The contact's assigned owner (avatar/initials), when one is set. */
  owner_user_id: string | null;
  owner_name: string | null;
}

export interface BoardFilters {
  /** Lead-origin groups expanded to kinds (matches the contacts Origen filter). */
  originKinds?: OriginKind[];
  /** The campaign of the contact's origin ad. */
  campaignId?: string;
  /** The contact's origin ad. */
  adId?: string;
  /** Opened (created_at) range — ISO strings. */
  openedFrom?: string;
  openedTo?: string;
  /** Narrow to one status. Default excludes 'lost' (that is the Perdidos view). */
  status?: OpportunityStatus;
  /** Include opportunities whose origin ad is a TEST ad (excluded by default, like everywhere). */
  includeTest?: boolean;
  limit?: number;
}

/** Board opportunities (default: everything NOT lost — the Pipeline columns; pass status='lost' for
 *  the Perdidos view). Test-ad-originated opportunities are excluded unless includeTest. */
export async function listBoardOpportunities(tenantId: string, clientId: string, filters: BoardFilters = {}): Promise<BoardOpportunityRow[]> {
  const params: unknown[] = [tenantId, clientId];
  const where: string[] = ['o.tenant_id = $1', 'o.client_id = $2'];
  if (filters.status) {
    params.push(filters.status);
    where.push(`o.status = $${params.length}`);
  } else {
    where.push(`o.status <> 'lost'`);
  }
  if (filters.originKinds && filters.originKinds.length > 0) {
    params.push(filters.originKinds);
    where.push(`ct.origin_kind = ANY($${params.length}::text[])`);
  }
  if (filters.campaignId) {
    params.push(filters.campaignId);
    where.push(`ad.campaign_id = $${params.length}`);
  }
  if (filters.adId) {
    params.push(filters.adId);
    where.push(`ft.ad_id = $${params.length}`);
  }
  if (filters.openedFrom) {
    params.push(filters.openedFrom);
    where.push(`o.created_at >= $${params.length}::timestamptz`);
  }
  if (filters.openedTo) {
    params.push(filters.openedTo);
    where.push(`o.created_at < $${params.length}::timestamptz`);
  }
  if (!filters.includeTest) where.push(`(ad.is_test IS NOT TRUE)`);
  params.push(Math.min(Math.max(filters.limit ?? 500, 1), 1000));
  const limitIdx = params.length;
  const r = await query<BoardOpportunityRow>(
    `SELECT o.id, o.contact_id, o.conversation_id, o.status, o.stage, o.created_at, o.lost_reason, o.lost_note, o.closed_at,
            CASE o.stage WHEN 'lead' THEN o.lead_at WHEN 'qualified' THEN o.qualified_at WHEN 'booked' THEN o.booked_at
                         WHEN 'attended' THEN o.attended_at WHEN 'paid' THEN o.paid_at END AS stage_since,
            ct.name AS contact_name, ct.channel_user_id AS contact_channel_user_id, ct.phone_e164 AS contact_phone_e164, ct.origin_kind,
            ad.name AS ad_name, ad.headline AS ad_headline, ad.is_test AS ad_is_test, camp.name AS campaign_name,
            lm.sender AS last_sender, lm.created_at AS last_message_at, lm.text AS last_message_text,
            pay.paid_total, pay.paid_method,
            o.qualification_service, o.qualification_timeframe, o.qualified_by, qu.name AS qualified_by_name,
            appt.start_at AS appt_start_at, appt.status AS appt_status, appt.price_snapshot AS appt_list_price, appt.tz AS appt_tz,
            ct.assigned_to AS owner_user_id, ou.name AS owner_name
       FROM opportunities o
       JOIN contacts ct ON ct.id = o.contact_id AND ct.tenant_id = o.tenant_id
       LEFT JOIN attribution_touches ft ON ft.id = ct.first_touch_id AND ft.tenant_id = o.tenant_id
       LEFT JOIN ads ad ON ad.id = ft.ad_id AND ad.tenant_id = o.tenant_id
       LEFT JOIN campaigns camp ON camp.id = ad.campaign_id AND camp.tenant_id = o.tenant_id
       LEFT JOIN "user" qu ON qu.id = o.qualified_by
       LEFT JOIN "user" ou ON ou.id = ct.assigned_to
       LEFT JOIN LATERAL (
         SELECT hm.sender, hm.created_at, hm.text FROM handoff_messages hm
          WHERE hm.tenant_id = o.tenant_id AND hm.conversation_id = o.conversation_id
          ORDER BY hm.created_at DESC, hm.id DESC LIMIT 1
       ) lm ON true
       LEFT JOIN LATERAL (
         -- The sale's most recent non-cancelled appointment: the upcoming one for a booked sale,
         -- the completed one for an attended/paid sale. Drives the Reservó / Asistió card lines.
         SELECT ap.start_at, ap.status, ap.price_snapshot::text AS price_snapshot, si.timezone AS tz
           FROM appointments ap
           JOIN sites si ON si.id = ap.site_id AND si.tenant_id = ap.tenant_id
          WHERE ap.tenant_id = o.tenant_id AND ap.opportunity_id = o.id AND ap.status <> 'cancelled'
          ORDER BY ap.start_at DESC, ap.id DESC LIMIT 1
       ) appt ON true
       LEFT JOIN LATERAL (
         -- The recorded payment(s) of this sale, via its appointments. Amount + method only (never
         -- commission); method is null when more than one payment backs the sale.
         SELECT SUM(p.total)::text AS paid_total,
                CASE WHEN count(*) = 1 THEN max(pm.label) END AS paid_method
           FROM appointments ap
           JOIN payments p ON p.appointment_id = ap.id AND p.tenant_id = ap.tenant_id AND p.status = 'recorded'
           LEFT JOIN payment_methods pm ON pm.tenant_id = p.tenant_id AND pm.client_id = p.client_id AND pm.key = p.method_key
          WHERE ap.tenant_id = o.tenant_id AND ap.opportunity_id = o.id
       ) pay ON true
      WHERE ${where.join(' AND ')}
      ORDER BY o.created_at DESC, o.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  return r.rows;
}

/** The "sin respuesta del negocio" queue: OPEN lead/qualified opportunities whose conversation's
 *  last message is from the CUSTOMER (PL-1 never auto-loses these). Longest wait first. */
export interface AwaitingReplyRow {
  id: string;
  contact_id: string;
  conversation_id: string | null;
  conversation_ref: string | null;
  stage: OpportunityStage;
  contact_name: string | null;
  contact_channel_user_id: string | null;
  contact_phone_e164: string | null;
  last_message_at: Date;
}
export async function listAwaitingBusinessReply(tenantId: string, clientId: string, limit = 200): Promise<AwaitingReplyRow[]> {
  const r = await query<AwaitingReplyRow>(
    `SELECT o.id, o.contact_id, o.conversation_id, cv.conversation_ref, o.stage,
            ct.name AS contact_name, ct.channel_user_id AS contact_channel_user_id, ct.phone_e164 AS contact_phone_e164,
            lm.created_at AS last_message_at
       FROM opportunities o
       JOIN contacts ct ON ct.id = o.contact_id AND ct.tenant_id = o.tenant_id
       LEFT JOIN conversations cv ON cv.id = o.conversation_id AND cv.tenant_id = o.tenant_id
       JOIN LATERAL (
         SELECT hm.sender, hm.created_at FROM handoff_messages hm
          WHERE hm.tenant_id = o.tenant_id AND hm.conversation_id = o.conversation_id
          ORDER BY hm.created_at DESC, hm.id DESC LIMIT 1
       ) lm ON true
      WHERE o.tenant_id = $1 AND o.client_id = $2 AND o.status = 'open' AND o.stage IN ('lead','qualified')
        AND o.conversation_id IS NOT NULL AND lm.sender = 'user'
      ORDER BY lm.created_at ASC
      LIMIT $3`,
    [tenantId, clientId, Math.min(Math.max(limit, 1), 500)],
  );
  return r.rows;
}

/** Every opportunity for a contact, newest first — the contact record's current + past sales. */
export async function listContactOpportunities(tenantId: string, clientId: string, contactId: string): Promise<OpportunityRow[]> {
  const r = await query<OpportunityRow>(
    `SELECT ${OPP_COLUMNS} FROM opportunities
      WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3
      ORDER BY created_at DESC, id DESC`,
    [tenantId, clientId, contactId],
  );
  return r.rows;
}

/** Compact origin + pipeline position for one contact — the Inbox conversation header (§6). */
export interface InboxContactPipeline {
  origin_kind: OriginKind | null;
  ad_name: string | null;
  ad_headline: string | null;
  ad_is_test: boolean | null;
  campaign_name: string | null;
  opp_stage: OpportunityStage | null;
  opp_status: OpportunityStatus | null;
}
export async function getInboxContactPipeline(tenantId: string, clientId: string, contactId: string): Promise<InboxContactPipeline | null> {
  const r = await query<InboxContactPipeline>(
    `SELECT ct.origin_kind, ad.name AS ad_name, ad.headline AS ad_headline, ad.is_test AS ad_is_test, camp.name AS campaign_name,
            opp.stage AS opp_stage, opp.status AS opp_status
       FROM contacts ct
       LEFT JOIN attribution_touches ft ON ft.id = ct.first_touch_id AND ft.tenant_id = ct.tenant_id
       LEFT JOIN ads ad ON ad.id = ft.ad_id AND ad.tenant_id = ct.tenant_id
       LEFT JOIN campaigns camp ON camp.id = ad.campaign_id AND camp.tenant_id = ct.tenant_id
       LEFT JOIN LATERAL (
         SELECT op.stage, op.status FROM opportunities op
          WHERE op.tenant_id = ct.tenant_id AND op.client_id = ct.client_id AND op.contact_id = ct.id
          ORDER BY (op.status = 'open') DESC, op.created_at DESC, op.id DESC LIMIT 1
       ) opp ON true
      WHERE ct.id = $3 AND ct.tenant_id = $1 AND ct.client_id = $2`,
    [tenantId, clientId, contactId],
  );
  return r.rows[0] ?? null;
}

/** Appointments linked to an opportunity (for the contact record card). */
export interface OpportunityAppointmentRow {
  id: string;
  start_at: Date;
  status: string;
  service_name_snapshot: string;
}
export async function listOpportunityAppointments(tenantId: string, opportunityId: string): Promise<OpportunityAppointmentRow[]> {
  const r = await query<OpportunityAppointmentRow>(
    `SELECT id, start_at, status, service_name_snapshot FROM appointments
      WHERE tenant_id = $1 AND opportunity_id = $2 ORDER BY start_at DESC`,
    [tenantId, opportunityId],
  );
  return r.rows;
}
