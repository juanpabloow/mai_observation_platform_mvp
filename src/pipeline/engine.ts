import type { PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';
import type { ActorType, AppointmentRow, AppointmentStatus } from '../db/repositories/scheduling/appointments.js';
import {
  getOpportunityById,
  type LostReason,
  type OpportunityRow,
  type OpportunityStage,
} from '../db/repositories/pipeline.js';

/**
 * SALES PIPELINE engine (PL-1 §2) — the automatic rules, as transactional operations. Every one
 * writes the opportunity change AND its `opportunity_stage_events` row in the SAME transaction, and
 * records the ACTOR. The rules are facts only: the opportunity (one sale), not the contact, moves
 * through lead→qualified→booked→attended, won on completion, lost on no-show / no-response.
 *
 * These functions THROW on failure; the fail-safe wrappers in `hooks.ts` (used by the message route
 * and the booking chokepoint) and the auto-lost sweep catch + count so a pipeline error never fails
 * the underlying write. `contacts.stage` is never touched here (a separate axis). `paid`/`paid_at`
 * are never written here (a later payments phase does, on the same won opportunity).
 */

// The actor behind a transition, recorded as text: 'system' | 'bot' | a user id.
export interface PipelineActor {
  kind: 'system' | 'bot' | 'user';
  userId?: string | null;
}
function actorText(a: PipelineActor): string {
  if (a.kind === 'user' && a.userId && a.userId.trim() !== '') return a.userId;
  return a.kind === 'bot' ? 'bot' : 'system';
}
/** Map a booking actor (appointments.ActorType + user id) to a pipeline actor. */
export function bookingActor(actorType: ActorType, actorUserId?: string | null): PipelineActor {
  if (actorUserId) return { kind: 'user', userId: actorUserId };
  if (actorType === 'n8n') return { kind: 'bot' };
  return { kind: 'system' };
}

const SELECT_LOCK = `SELECT id, tenant_id, client_id, contact_id, conversation_id, status, stage,
  lead_at, qualified_at, booked_at, attended_at, paid_at, origin_touch_id, qualified_by,
  qualification_service, qualification_timeframe, qualification_message_id, qualified_implicitly,
  lost_reason, lost_note, closed_at, created_at, updated_at`;

interface EventInput {
  tenantId: string;
  clientId: string;
  opportunityId: string;
  fromStage: OpportunityStage | null;
  toStage: OpportunityStage | null;
  fromStatus: OpportunityRow['status'] | null;
  toStatus: OpportunityRow['status'] | null;
  actor: PipelineActor;
  reason?: string | null;
}
async function writeEvent(client: PoolClient, e: EventInput): Promise<void> {
  await client.query(
    `INSERT INTO opportunity_stage_events
       (tenant_id, client_id, opportunity_id, from_stage, to_stage, from_status, to_status, actor, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [e.tenantId, e.clientId, e.opportunityId, e.fromStage, e.toStage, e.fromStatus, e.toStatus, actorText(e.actor), e.reason ?? null],
  );
}

/** The contact that OWNS a conversation (the sender), or null if unlinked. */
async function conversationContactId(client: PoolClient, tenantId: string, conversationId: string): Promise<string | null> {
  const r = await client.query<{ contact_id: string | null }>(
    `SELECT contact_id FROM conversations WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId],
  );
  return r.rows[0]?.contact_id ?? null;
}

async function touchForMessage(client: PoolClient, tenantId: string, messageId: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `SELECT id FROM attribution_touches WHERE tenant_id = $1 AND message_id = $2`,
    [tenantId, messageId],
  );
  return r.rows[0]?.id ?? null;
}

/** The contact's most recent NON-TEST ad touch inside the client's brief window (origin for a new sale). */
async function latestAdTouchInWindow(client: PoolClient, tenantId: string, clientId: string, contactId: string): Promise<string | null> {
  const r = await client.query<{ id: string }>(
    `WITH win AS (
       SELECT COALESCE((SELECT brief_window_days FROM attribution_settings WHERE tenant_id = $1 AND client_id = $2), 7) AS days
     )
     SELECT t.id FROM attribution_touches t
       JOIN ads a ON a.id = t.ad_id AND a.tenant_id = t.tenant_id
       CROSS JOIN win
      WHERE t.tenant_id = $1 AND t.client_id = $2 AND t.contact_id = $3 AND a.is_test = false
        AND t.occurred_at >= now() - make_interval(days => win.days)
      ORDER BY t.occurred_at DESC, t.id DESC
      LIMIT 1`,
    [tenantId, clientId, contactId],
  );
  return r.rows[0]?.id ?? null;
}

async function contactHasAnyAppointment(client: PoolClient, tenantId: string, clientId: string, contactId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM appointments WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3 LIMIT 1`,
    [tenantId, clientId, contactId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function hasOtherActiveAppointment(client: PoolClient, tenantId: string, opportunityId: string, exceptApptId: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM appointments
      WHERE tenant_id = $1 AND opportunity_id = $2 AND id <> $3 AND status IN ('scheduled', 'confirmed')
      LIMIT 1`,
    [tenantId, opportunityId, exceptApptId],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Lock (FOR UPDATE) the contact's open opportunity, or null. */
async function lockOpenForContact(client: PoolClient, tenantId: string, clientId: string, contactId: string): Promise<OpportunityRow | null> {
  const r = await client.query<OpportunityRow>(
    `${SELECT_LOCK} FROM opportunities
      WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3 AND status = 'open'
      FOR UPDATE`,
    [tenantId, clientId, contactId],
  );
  return r.rows[0] ?? null;
}

async function latestForContact(client: PoolClient, tenantId: string, clientId: string, contactId: string): Promise<OpportunityRow | null> {
  const r = await client.query<OpportunityRow>(
    `${SELECT_LOCK} FROM opportunities
      WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [tenantId, clientId, contactId],
  );
  return r.rows[0] ?? null;
}

async function reopenWindowDays(client: PoolClient, tenantId: string, clientId: string): Promise<number> {
  const r = await client.query<{ reopen_window_days: number }>(
    `SELECT reopen_window_days FROM pipeline_settings WHERE tenant_id = $1 AND client_id = $2`,
    [tenantId, clientId],
  );
  return r.rows[0]?.reopen_window_days ?? 30;
}
function lostWithinWindow(opp: OpportunityRow, windowDays: number): boolean {
  if (opp.status !== 'lost' || !opp.closed_at) return false;
  return Date.now() - opp.closed_at.getTime() <= windowDays * 86_400_000;
}

interface OpenInput {
  tenantId: string;
  clientId: string;
  contactId: string;
  conversationId: string | null;
  stage: OpportunityStage;
  originTouchId: string | null;
  actor: PipelineActor;
  reason: string;
}
/**
 * Insert a new opportunity at `stage` (ON CONFLICT with the one-open-per-contact index → returns
 * null when a concurrent open already exists). When created, writes the opening event. A sale
 * opened directly at `booked` is implicitly qualified (skips the qualification step).
 */
async function tryOpen(client: PoolClient, input: OpenInput): Promise<OpportunityRow | null> {
  const bookedAt = input.stage === 'booked' ? 'now()' : 'NULL';
  // Opening directly at booked skips qualification (implicitly qualified).
  const implicit = input.stage === 'booked';
  const qualifiedAt = input.stage === 'lead' ? 'NULL' : 'now()';
  const r = await client.query<OpportunityRow>(
    `INSERT INTO opportunities
       (tenant_id, client_id, contact_id, conversation_id, status, stage,
        lead_at, qualified_at, booked_at, origin_touch_id, qualified_by, qualified_implicitly)
     VALUES ($1,$2,$3,$4,'open',$5, now(), ${qualifiedAt}, ${bookedAt}, $6, $7, $8)
     ON CONFLICT (tenant_id, client_id, contact_id) WHERE status = 'open' DO NOTHING
     RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
    [input.tenantId, input.clientId, input.contactId, input.conversationId, input.stage,
      input.originTouchId, implicit ? actorText(input.actor) : null, implicit],
  );
  const created = r.rows[0];
  if (!created) return null;
  await writeEvent(client, {
    tenantId: input.tenantId, clientId: input.clientId, opportunityId: created.id,
    fromStage: null, toStage: input.stage, fromStatus: null, toStatus: 'open',
    actor: input.actor, reason: input.reason,
  });
  return created;
}

/** Reopen a LOST opportunity at the stage it had when lost, keeping its origin. Writes the event. */
async function reopen(client: PoolClient, opp: OpportunityRow, conversationId: string | null, actor: PipelineActor, reason: string): Promise<OpportunityRow> {
  const r = await client.query<OpportunityRow>(
    `UPDATE opportunities
        SET status = 'open', closed_at = NULL, lost_reason = NULL, lost_note = NULL,
            conversation_id = COALESCE(conversation_id, $2), updated_at = now()
      WHERE id = $1 AND status = 'lost'
      RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
    [opp.id, conversationId],
  );
  const reopened = r.rows[0]!;
  await writeEvent(client, {
    tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id,
    fromStage: opp.stage, toStage: reopened.stage, fromStatus: 'lost', toStatus: 'open',
    actor, reason,
  });
  return reopened;
}

/** Advance an OPEN opportunity to `booked` (monotonic). From `lead`, qualification is implicit. */
async function advanceToBooked(client: PoolClient, opp: OpportunityRow, conversationId: string | null, actor: PipelineActor): Promise<void> {
  if (opp.stage === 'lead' || opp.stage === 'qualified') {
    const fromLead = opp.stage === 'lead';
    await client.query(
      `UPDATE opportunities
          SET stage = 'booked',
              booked_at = COALESCE(booked_at, now()),
              qualified_at = COALESCE(qualified_at, now()),
              qualified_implicitly = CASE WHEN $2 THEN true ELSE qualified_implicitly END,
              qualified_by = CASE WHEN $2 AND qualified_by IS NULL THEN $3 ELSE qualified_by END,
              conversation_id = COALESCE(conversation_id, $4),
              updated_at = now()
        WHERE id = $1`,
      [opp.id, fromLead, actorText(actor), conversationId],
    );
    await writeEvent(client, {
      tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id,
      fromStage: opp.stage, toStage: 'booked', fromStatus: 'open', toStatus: 'open',
      actor, reason: 'booking',
    });
  } else {
    // Already booked/attended/paid: record the booking timestamp + conversation, but no transition.
    await client.query(
      `UPDATE opportunities SET booked_at = COALESCE(booked_at, now()), conversation_id = COALESCE(conversation_id, $2), updated_at = now() WHERE id = $1`,
      [opp.id, conversationId],
    );
  }
}

async function linkAppointment(client: PoolClient, tenantId: string, appointmentId: string, opportunityId: string): Promise<void> {
  await client.query(
    `UPDATE appointments SET opportunity_id = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2`,
    [appointmentId, tenantId, opportunityId],
  );
}

// ── Public operations (composed by hooks, the auto-lost sweep, and PL-2/PL-3) ──────────────

/**
 * §2 OPENING (inbound message). Opens a new lead, or reopens a recently-lost sale, per the rules:
 *   - already has an open opportunity → nothing;
 *   - latest was LOST within reopen_window_days → reopen it (keep origin);
 *   - else open a new lead IFF this message carries an ad touch, OR the contact has never had an
 *     opportunity nor an appointment (a returning customer's ordinary message opens nothing).
 */
export async function openOnInbound(input: { tenantId: string; clientId: string; contactId: string; conversationId: string | null; messageId: string }): Promise<void> {
  await withTransaction(async (client) => {
    const open = await lockOpenForContact(client, input.tenantId, input.clientId, input.contactId);
    if (open) return;
    const latest = await latestForContact(client, input.tenantId, input.clientId, input.contactId);
    if (latest && lostWithinWindow(latest, await reopenWindowDays(client, input.tenantId, input.clientId))) {
      await reopen(client, latest, input.conversationId, { kind: 'system' }, 'inbound');
      return;
    }
    const touchId = await touchForMessage(client, input.tenantId, input.messageId);
    if (touchId) {
      await tryOpen(client, { ...input, stage: 'lead', originTouchId: touchId, actor: { kind: 'system' }, reason: 'inbound_ad' });
      return;
    }
    // Brand-new only when the contact has NO prior opportunity AND no appointment.
    if (!latest && !(await contactHasAnyAppointment(client, input.tenantId, input.clientId, input.contactId))) {
      const origin = await latestAdTouchInWindow(client, input.tenantId, input.clientId, input.contactId);
      await tryOpen(client, { ...input, stage: 'lead', originTouchId: origin, actor: { kind: 'system' }, reason: 'inbound_new' });
    }
    // Otherwise (returning customer, ordinary message) → nothing.
  });
}

/**
 * §2 BOOKING. Links the appointment to the right sale and advances it to `booked`. The target is
 * the SENDER's sale for a conversational (machine-API) booking — the conversation is the sale, even
 * for a third-party attendee — else the attendee's. With no open sale: reopen a recently-lost one,
 * else create a new one directly at booked (origin = the contact's latest ad touch in the window).
 */
export async function onBookingCreated(appt: AppointmentRow, actor: PipelineActor): Promise<void> {
  await withTransaction(async (client) => {
    let targetContactId = appt.contact_id;
    if (appt.source_conversation_id) {
      const sender = await conversationContactId(client, appt.tenant_id, appt.source_conversation_id);
      if (sender) targetContactId = sender;
    }
    if (!targetContactId) return; // nothing to link a sale to

    let opp = await lockOpenForContact(client, appt.tenant_id, appt.client_id, targetContactId);
    if (!opp) {
      const latest = await latestForContact(client, appt.tenant_id, appt.client_id, targetContactId);
      if (latest && lostWithinWindow(latest, await reopenWindowDays(client, appt.tenant_id, appt.client_id))) {
        opp = await reopen(client, latest, appt.source_conversation_id, actor, 'booking');
      } else {
        const origin = await latestAdTouchInWindow(client, appt.tenant_id, appt.client_id, targetContactId);
        opp = await tryOpen(client, {
          tenantId: appt.tenant_id, clientId: appt.client_id, contactId: targetContactId,
          conversationId: appt.source_conversation_id, stage: 'booked', originTouchId: origin,
          actor, reason: 'booking_new',
        });
        // Lost the open-insert race → an open sale now exists; advance it instead.
        if (!opp) opp = await lockOpenForContact(client, appt.tenant_id, appt.client_id, targetContactId);
        if (opp) {
          await linkAppointment(client, appt.tenant_id, appt.id, opp.id);
          return; // tryOpen already created it at booked (or we advance the raced-in open below)
        }
      }
    }
    if (!opp) return;
    await advanceToBooked(client, opp, appt.source_conversation_id, actor);
    await linkAppointment(client, appt.tenant_id, appt.id, opp.id);
  });
}

/**
 * §2 AFTER BOOKING. Appointment status drives the linked sale:
 *   completed → attended + won (closed); no_show → lost (no_asistio);
 *   cancelled with no other active appointment → back to qualified; reschedule/confirm → no change.
 */
export async function onAppointmentStatusChanged(appt: AppointmentRow, target: AppointmentStatus, actor: PipelineActor): Promise<void> {
  if (!appt.opportunity_id) return;
  if (target !== 'completed' && target !== 'no_show' && target !== 'cancelled') return;
  await withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(
      `${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`,
      [appt.opportunity_id, appt.tenant_id, appt.client_id],
    );
    const opp = r.rows[0];
    if (!opp || opp.status !== 'open') return; // already closed → idempotent no-op

    if (target === 'completed') {
      await client.query(
        `UPDATE opportunities SET stage = 'attended', attended_at = now(), status = 'won', closed_at = now(), updated_at = now() WHERE id = $1`,
        [opp.id],
      );
      await writeEvent(client, {
        tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id,
        fromStage: opp.stage, toStage: 'attended', fromStatus: 'open', toStatus: 'won', actor, reason: 'appointment_completed',
      });
    } else if (target === 'no_show') {
      await client.query(
        `UPDATE opportunities SET status = 'lost', lost_reason = 'no_asistio', closed_at = now(), updated_at = now() WHERE id = $1`,
        [opp.id],
      );
      await writeEvent(client, {
        tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id,
        fromStage: opp.stage, toStage: opp.stage, fromStatus: 'open', toStatus: 'lost', actor, reason: 'no_asistio',
      });
    } else {
      // cancelled: revert booked → qualified only when no OTHER active appointment remains.
      if (opp.stage !== 'booked') return;
      if (await hasOtherActiveAppointment(client, appt.tenant_id, opp.id, appt.id)) return;
      await client.query(`UPDATE opportunities SET stage = 'qualified', updated_at = now() WHERE id = $1`, [opp.id]);
      await writeEvent(client, {
        tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id,
        fromStage: 'booked', toStage: 'qualified', fromStatus: 'open', toStatus: 'open', actor, reason: 'appointment_cancelled',
      });
    }
  });
}

// ── Repository-grade operations for PL-2 (people) and PL-3 (bot) — same rules, actor recorded ──

export interface QualifyInput {
  service?: string | null;
  timeframe?: string | null;
  messageId?: string | null;
  implicit?: boolean;
}
/** The lead → qualified write + its one event, under an already-held row lock. Caller guarantees
 *  `opp` is an OPEN lead. Single-sourced so the person (PL-2) and bot (PL-3) paths agree exactly. */
async function applyQualify(client: PoolClient, opp: OpportunityRow, input: QualifyInput, actor: PipelineActor): Promise<OpportunityRow> {
  const u = await client.query<OpportunityRow>(
    `UPDATE opportunities
        SET stage = 'qualified', qualified_at = now(), qualified_by = $2,
            qualification_service = $3, qualification_timeframe = $4, qualification_message_id = $5,
            qualified_implicitly = $6, updated_at = now()
      WHERE id = $1
      RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
    [opp.id, actorText(actor), input.service ?? null, input.timeframe ?? null, input.messageId ?? null, input.implicit ?? false],
  );
  await writeEvent(client, { tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id, fromStage: 'lead', toStage: 'qualified', fromStatus: 'open', toStatus: 'open', actor, reason: 'qualified' });
  return u.rows[0]!;
}

/** Open a NEW sale DIRECTLY at `qualified` with evidence (PL-3 bot: the customer said what + when,
 *  no prior open sale). One opening event straight to `qualified`. ON CONFLICT with the one-open-
 *  per-contact index → null (a concurrent open raced in). */
async function openAtQualified(client: PoolClient, input: { tenantId: string; clientId: string; contactId: string; conversationId: string | null; originTouchId: string | null; actor: PipelineActor; evidence: QualifyInput }): Promise<OpportunityRow | null> {
  const r = await client.query<OpportunityRow>(
    `INSERT INTO opportunities
       (tenant_id, client_id, contact_id, conversation_id, status, stage,
        lead_at, qualified_at, origin_touch_id, qualified_by,
        qualification_service, qualification_timeframe, qualification_message_id, qualified_implicitly)
     VALUES ($1,$2,$3,$4,'open','qualified', now(), now(), $5, $6, $7, $8, $9, false)
     ON CONFLICT (tenant_id, client_id, contact_id) WHERE status = 'open' DO NOTHING
     RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
    [input.tenantId, input.clientId, input.contactId, input.conversationId, input.originTouchId,
      actorText(input.actor), input.evidence.service ?? null, input.evidence.timeframe ?? null, input.evidence.messageId ?? null],
  );
  const created = r.rows[0];
  if (!created) return null;
  await writeEvent(client, {
    tenantId: input.tenantId, clientId: input.clientId, opportunityId: created.id,
    fromStage: null, toStage: 'qualified', fromStatus: null, toStatus: 'open',
    actor: input.actor, reason: 'bot_qualify_new',
  });
  return created;
}

/** Qualify an OPEN lead (lead → qualified) with evidence + actor. No-op if not an open lead. */
export async function qualifyOpportunity(tenantId: string, clientId: string, opportunityId: string, input: QualifyInput, actor: PipelineActor): Promise<OpportunityRow | null> {
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.status !== 'open' || opp.stage !== 'lead') return opp ?? null;
    return applyQualify(client, opp, input, actor);
  });
}

export interface BotQualifyResult {
  /** The sale after the decision (the one the bot qualified, reopened, or created). */
  opportunity: OpportunityRow;
  /** True when this call actually moved the sale (wrote an event); false on an idempotent repeat. */
  changed: boolean;
}

/**
 * PL-3 — the BOT qualifies the CURRENT conversation's sale (the customer said WHAT service + WHEN),
 * as ONE transactional decision that follows the SAME opening / reopen / origin rules as an inbound
 * message. The bot decides WHEN this is true; this records it. actor = { kind: 'bot' }. It keys on
 * the contact (the one-open-per-contact invariant), never on an opportunity id the caller supplies:
 *   • open lead                          → qualify it (one event)                     → changed
 *   • open qualified / booked            → no change (idempotent; evidence untouched) → not changed
 *   • latest sale WON (attended/closed)  → no change — a completed sale is terminal    → not changed
 *   • no open sale, latest LOST within the reopen window → reopen it (keep origin) and,
 *     if it came back at lead, qualify — both recorded                                 → changed
 *   • otherwise (never had a sale, or the latest was lost OUTSIDE the window) → open a NEW
 *     sale DIRECTLY at qualified with the evidence (origin = the contact's latest ad touch
 *     in the brief window, if any)                                                     → changed
 */
export async function qualifyFromBot(
  tenantId: string,
  clientId: string,
  contactId: string,
  conversationId: string | null,
  input: QualifyInput,
  actor: PipelineActor,
): Promise<BotQualifyResult> {
  return withTransaction(async (client) => {
    const evidence: QualifyInput = { service: input.service ?? null, timeframe: input.timeframe ?? null, messageId: input.messageId ?? null, implicit: false };

    const open = await lockOpenForContact(client, tenantId, clientId, contactId);
    if (open) {
      if (open.stage === 'lead') return { opportunity: await applyQualify(client, open, evidence, actor), changed: true };
      return { opportunity: open, changed: false }; // already qualified/booked/attended → idempotent
    }

    const latest = await latestForContact(client, tenantId, clientId, contactId);
    // A completed (won/attended) sale is terminal — never spin a NEW sale off a qualify call.
    if (latest && latest.status === 'won') return { opportunity: latest, changed: false };
    // A sale lost INSIDE the reopen window comes back (keeping its origin); qualify it if it
    // returned at lead. (An ordinary inbound usually reopens it already; this covers the rest.)
    if (latest && latest.status === 'lost' && lostWithinWindow(latest, await reopenWindowDays(client, tenantId, clientId))) {
      const reopened = await reopen(client, latest, conversationId, actor, 'bot_qualify_reopen');
      if (reopened.stage === 'lead') return { opportunity: await applyQualify(client, reopened, evidence, actor), changed: true };
      return { opportunity: reopened, changed: true }; // reopened already at qualified+ (keeps prior evidence)
    }

    // Otherwise (never had a sale, or the latest was lost OUTSIDE the window) → open a NEW sale
    // directly at qualified (origin = the contact's latest ad touch in the brief window, if any).
    const origin = await latestAdTouchInWindow(client, tenantId, clientId, contactId);
    const created = await openAtQualified(client, { tenantId, clientId, contactId, conversationId, originTouchId: origin, actor, evidence });
    if (created) return { opportunity: created, changed: true };

    // Lost the one-open-per-contact insert race → an open sale appeared; qualify it if it's a lead.
    const raced = await lockOpenForContact(client, tenantId, clientId, contactId);
    if (raced) return raced.stage === 'lead' ? { opportunity: await applyQualify(client, raced, evidence, actor), changed: true } : { opportunity: raced, changed: false };
    throw new Error('qualifyFromBot: lost the open-insert race but found no open sale'); // unreachable
  });
}

/** Undo a qualification (qualified → lead), clearing the evidence. No-op if not an open qualified
 *  sale. An optional note is recorded as the stage-event reason. */
export async function unqualifyOpportunity(tenantId: string, clientId: string, opportunityId: string, actor: PipelineActor, note?: string | null): Promise<OpportunityRow | null> {
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.status !== 'open' || opp.stage !== 'qualified') return opp ?? null;
    const u = await client.query<OpportunityRow>(
      `UPDATE opportunities
          SET stage = 'lead', qualified_at = NULL, qualified_by = NULL, qualification_service = NULL,
              qualification_timeframe = NULL, qualification_message_id = NULL, qualified_implicitly = false, updated_at = now()
        WHERE id = $1
        RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
      [opportunityId],
    );
    await writeEvent(client, { tenantId, clientId, opportunityId, fromStage: 'qualified', toStage: 'lead', fromStatus: 'open', toStatus: 'open', actor, reason: (note && note.trim()) || 'unqualified' });
    return u.rows[0]!;
  });
}

/** Mark an OPEN sale lost with a reason (note required when 'otro'). No-op if not open. */
export async function markOpportunityLost(tenantId: string, clientId: string, opportunityId: string, reason: LostReason, note: string | null, actor: PipelineActor): Promise<OpportunityRow | null> {
  if (reason === 'otro' && (!note || note.trim() === '')) throw new Error('lost_note is required when reason is otro');
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.status !== 'open') return opp ?? null;
    const u = await client.query<OpportunityRow>(
      `UPDATE opportunities SET status = 'lost', lost_reason = $2, lost_note = $3, closed_at = now(), updated_at = now()
        WHERE id = $1 RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
      [opportunityId, reason, note ?? null],
    );
    await writeEvent(client, { tenantId, clientId, opportunityId, fromStage: opp.stage, toStage: opp.stage, fromStatus: 'open', toStatus: 'lost', actor, reason });
    return u.rows[0]!;
  });
}

/**
 * §2 AUTO-LOST ("no respondió"). Lose an OPEN lead/qualified sale whose conversation's LAST message
 * is from the BUSINESS (bot/human agent) and has gone unanswered for auto_lost_after_hours. Re-checks
 * EVERYTHING under the row lock — stage is still lead/qualified, the customer still hasn't replied,
 * the gap is still stale — so a booking or a customer reply that landed since the sweep selected it
 * is respected (a sale the customer answered, or that advanced to booked, is never auto-lost). If the
 * customer spoke last, we NEVER lose it (the business failed to answer, not the lead). Returns true
 * only when it was actually lost.
 */
export async function autoLoseIfUnanswered(tenantId: string, clientId: string, opportunityId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.status !== 'open' || !(opp.stage === 'lead' || opp.stage === 'qualified') || !opp.conversation_id) return false;
    const lm = await client.query<{ sender: string; created_at: Date }>(
      `SELECT sender, created_at FROM handoff_messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [tenantId, opp.conversation_id],
    );
    const last = lm.rows[0];
    // Customer spoke last (or no messages) → NEVER auto-lose.
    if (!last || (last.sender !== 'bot' && last.sender !== 'human_agent')) return false;
    const h = await client.query<{ hours: number }>(
      `SELECT COALESCE((SELECT auto_lost_after_hours FROM pipeline_settings WHERE tenant_id = $1 AND client_id = $2), 72) AS hours`,
      [tenantId, clientId],
    );
    const hours = h.rows[0]?.hours ?? 72;
    if (Date.now() - last.created_at.getTime() < hours * 3_600_000) return false; // no longer stale
    await client.query(`UPDATE opportunities SET status = 'lost', lost_reason = 'no_respondio', closed_at = now(), updated_at = now() WHERE id = $1`, [opportunityId]);
    await writeEvent(client, {
      tenantId, clientId, opportunityId, fromStage: opp.stage, toStage: opp.stage,
      fromStatus: 'open', toStatus: 'lost', actor: { kind: 'system' }, reason: 'no_respondio',
    });
    return true;
  });
}

/** Manually reopen a LOST sale (no window check — a person/bot decided). No-op if not lost. */
export async function reopenOpportunity(tenantId: string, clientId: string, opportunityId: string, actor: PipelineActor): Promise<OpportunityRow | null> {
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.status !== 'lost') return opp ?? null;
    return reopen(client, opp, opp.conversation_id, actor, 'manual_reopen');
  });
}

/**
 * PY-1: a recorded payment advances the WON sale attended → paid (one event; status stays won).
 * No-op unless the sale is won at attended — a paid stage is terminal and idempotent. Called
 * fail-safe from the payment hook, never rolling back the payment.
 */
export async function markOpportunityPaid(tenantId: string, clientId: string, opportunityId: string, actor: PipelineActor): Promise<OpportunityRow | null> {
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.stage === 'paid') return opp ?? null; // idempotent: already paid
    if (opp.status !== 'won' || opp.stage !== 'attended') return opp; // only a completed sale can be paid
    const u = await client.query<OpportunityRow>(
      `UPDATE opportunities SET stage = 'paid', paid_at = now(), updated_at = now() WHERE id = $1 RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
      [opportunityId],
    );
    await writeEvent(client, { tenantId, clientId, opportunityId, fromStage: 'attended', toStage: 'paid', fromStatus: 'won', toStatus: 'won', actor, reason: 'payment_recorded' });
    return u.rows[0]!;
  });
}

/** PY-1: voiding the payment reverts paid → attended (one event; still won). No-op unless paid. */
export async function revertOpportunityPaid(tenantId: string, clientId: string, opportunityId: string, actor: PipelineActor): Promise<OpportunityRow | null> {
  return withTransaction(async (client) => {
    const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [opportunityId, tenantId, clientId]);
    const opp = r.rows[0];
    if (!opp || opp.stage !== 'paid') return opp ?? null; // idempotent: not paid
    const u = await client.query<OpportunityRow>(
      `UPDATE opportunities SET stage = 'attended', paid_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
      [opportunityId],
    );
    await writeEvent(client, { tenantId, clientId, opportunityId, fromStage: 'paid', toStage: 'attended', fromStatus: 'won', toStatus: 'won', actor, reason: 'payment_voided' });
    return u.rows[0]!;
  });
}

/** A recorded payment is definitive: the sale is WON and PAID. Fast-forward an OPEN or WON
 *  opportunity straight to paid, filling the funnel timestamps it skipped (idempotent if paid). */
async function payInPlace(client: PoolClient, opp: OpportunityRow, actor: PipelineActor): Promise<void> {
  if (opp.stage === 'paid') return;
  await client.query(
    `UPDATE opportunities
        SET status = 'won', stage = 'paid',
            qualified_implicitly = CASE WHEN qualified_at IS NULL THEN true ELSE qualified_implicitly END,
            qualified_at = COALESCE(qualified_at, now()),
            booked_at = COALESCE(booked_at, now()),
            attended_at = COALESCE(attended_at, now()),
            paid_at = now(),
            closed_at = COALESCE(closed_at, now()),
            updated_at = now()
      WHERE id = $1`,
    [opp.id],
  );
  await writeEvent(client, {
    tenantId: opp.tenant_id, clientId: opp.client_id, opportunityId: opp.id,
    fromStage: opp.stage, toStage: 'paid', fromStatus: opp.status, toStatus: 'won', actor, reason: 'payment_recorded',
  });
}

/** Insert a NEW opportunity directly at won+paid (origin = the contact's latest ad touch in the
 *  brief window). A won row never collides with the one-OPEN-per-contact index, so this only runs
 *  when the contact has no open sale (the caller advances an existing open one instead). */
async function tryOpenPaid(client: PoolClient, input: { tenantId: string; clientId: string; contactId: string; conversationId: string | null; originTouchId: string | null; actor: PipelineActor }): Promise<OpportunityRow> {
  const r = await client.query<OpportunityRow>(
    `INSERT INTO opportunities
       (tenant_id, client_id, contact_id, conversation_id, status, stage,
        lead_at, qualified_at, booked_at, attended_at, paid_at, closed_at,
        origin_touch_id, qualified_by, qualified_implicitly)
     VALUES ($1,$2,$3,$4,'won','paid', now(),now(),now(),now(),now(),now(), $5, $6, true)
     RETURNING ${SELECT_LOCK.replace(/^SELECT /, '')}`,
    [input.tenantId, input.clientId, input.contactId, input.conversationId, input.originTouchId, actorText(input.actor)],
  );
  const created = r.rows[0]!;
  await writeEvent(client, {
    tenantId: input.tenantId, clientId: input.clientId, opportunityId: created.id,
    fromStage: null, toStage: 'paid', fromStatus: null, toStatus: 'won', actor: input.actor, reason: 'payment_new',
  });
  return created;
}

/**
 * JP-6: a recorded payment must leave its sale at `paid`. The fail-safe heal the payment hook and
 * the backfill both call:
 *   A) the appointment already links a sale → fast-forward it to paid (reopen first if it was lost);
 *   B) no sale but the appointment has a CONTACT → advance the contact's open sale, else create one
 *      directly at paid (origin = the latest ad touch in the brief window), and link the appointment;
 *   a guest walk-in with no contact → nothing to attach a sale to (no-op).
 * Idempotent (already paid → no change). Returns the paid opportunity, or null when none applies.
 */
export async function ensureOpportunityPaidForPayment(appt: AppointmentRow, actor: PipelineActor): Promise<OpportunityRow | null> {
  return withTransaction(async (client) => {
    if (appt.opportunity_id) {
      const r = await client.query<OpportunityRow>(`${SELECT_LOCK} FROM opportunities WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`, [appt.opportunity_id, appt.tenant_id, appt.client_id]);
      const opp = r.rows[0];
      if (opp) {
        if (opp.stage === 'paid') return opp; // idempotent
        const live = opp.status === 'lost' ? await reopen(client, opp, appt.source_conversation_id, actor, 'payment_recorded') : opp;
        await payInPlace(client, live, actor);
        return await getOpportunityById(appt.tenant_id, appt.client_id, opp.id, client);
      }
      // a dangling opportunity_id (the sale was deleted) → fall through and attach a fresh one.
    }
    const contactId = appt.contact_id;
    if (!contactId) return null; // a guest walk-in has no contact to own a sale
    let opp = await lockOpenForContact(client, appt.tenant_id, appt.client_id, contactId);
    if (opp) {
      await payInPlace(client, opp, actor);
    } else {
      const origin = await latestAdTouchInWindow(client, appt.tenant_id, appt.client_id, contactId);
      opp = await tryOpenPaid(client, { tenantId: appt.tenant_id, clientId: appt.client_id, contactId, conversationId: appt.source_conversation_id, originTouchId: origin, actor });
    }
    await linkAppointment(client, appt.tenant_id, appt.id, opp.id);
    return await getOpportunityById(appt.tenant_id, appt.client_id, opp.id, client);
  });
}

export { getOpportunityById };
