import type { PoolClient } from 'pg';
import { query } from '../client.js';

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
