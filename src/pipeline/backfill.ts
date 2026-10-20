import { query, withTransaction } from '../db/client.js';
import type { LostReason, OpportunityStage, OpportunityStatus } from '../db/repositories/pipeline.js';

/**
 * PL-1 §3 — pipeline backfill. DRY-RUN by default; `apply` writes. Idempotent: it only builds sales
 * for contacts that currently have NO opportunity, so a second run (and any sale live §2 has already
 * created) is left untouched. For each such contact it REPLAYS its history from the client's
 * attribution_settings.tracking_started_at onward — ad touches, the first organic message, and
 * appointments with their current status — through the same §2 rules (open/reopen → booked →
 * attended/won or no_show/lost, cancel → qualified), then applies auto-lost to a still-open
 * lead/qualified sale the business answered last. Nothing before tracking_started_at is created.
 *
 * Model note (documented simplification): the replay reconstructs each contact's sale SEQUENCE from
 * the durable facts we have (touches, first message, appointments). Stage timestamps come from those
 * source events (completion/no-show use the appointment's start_at); the cancel→qualified revert is
 * applied per event and re-advanced by any later booking, matching live §2 for the common cases.
 */

const DAY_MS = 86_400_000;

export interface PipelineBackfillSummary {
  apply: boolean;
  clientsProcessed: number;
  contactsScanned: number;
  opportunitiesCreated: number;
  autoLost: number;
  byStage: Record<OpportunityStage, number>;
  byStatus: Record<OpportunityStatus, number>;
  byOrigin: Record<string, number>;
  /** Per driving ad (origin touch). Test ads (is_test) are tallied separately, never mixed in. */
  byAd: Array<{ adExternalId: string; isTest: boolean; count: number }>;
}

interface ReconOpp {
  contactId: string;
  conversationId: string | null;
  status: OpportunityStatus;
  stage: OpportunityStage;
  leadAt: Date;
  qualifiedAt: Date | null;
  bookedAt: Date | null;
  attendedAt: Date | null;
  originTouchId: string | null;
  qualifiedImplicitly: boolean;
  lostReason: LostReason | null;
  closedAt: Date | null;
  appointmentIds: string[];
}

type Ev =
  | { type: 'ad'; time: Date; touchId: string; convId: string | null }
  | { type: 'organic'; time: Date; convId: string | null }
  | { type: 'booking'; time: Date; apptId: string; status: string; startAt: Date; convId: string | null };

/** Replay one contact's events (sorted) through the §2 rules → the sales they imply. */
function reconstruct(contactId: string, events: Ev[], reopenWinMs: number, briefWinMs: number): ReconOpp[] {
  const result: ReconOpp[] = [];
  let open: ReconOpp | null = null;
  let lastTouch: { id: string; time: Date } | null = null;

  const reopenPrior = (time: Date, convId: string | null): boolean => {
    const prior = result[result.length - 1];
    if (prior && prior.status === 'lost' && prior.closedAt && time.getTime() - prior.closedAt.getTime() <= reopenWinMs) {
      open = result.pop()!;
      open.status = 'open';
      open.closedAt = null;
      open.lostReason = null;
      if (!open.conversationId) open.conversationId = convId;
      return true;
    }
    return false;
  };
  const close = () => { if (open) { result.push(open); open = null; } };

  for (const ev of events) {
    if (ev.type === 'ad') {
      lastTouch = { id: ev.touchId, time: ev.time };
      if (open) continue;
      if (!reopenPrior(ev.time, ev.convId)) {
        open = { contactId, conversationId: ev.convId, status: 'open', stage: 'lead', leadAt: ev.time, qualifiedAt: null, bookedAt: null, attendedAt: null, originTouchId: ev.touchId, qualifiedImplicitly: false, lostReason: null, closedAt: null, appointmentIds: [] };
      }
    } else if (ev.type === 'organic') {
      if (open || result.length) continue; // only a brand-new contact's very first message opens organically
      open = { contactId, conversationId: ev.convId, status: 'open', stage: 'lead', leadAt: ev.time, qualifiedAt: null, bookedAt: null, attendedAt: null, originTouchId: null, qualifiedImplicitly: false, lostReason: null, closedAt: null, appointmentIds: [] };
    } else {
      if (!open && !reopenPrior(ev.time, ev.convId)) {
        const origin = lastTouch && ev.time.getTime() - lastTouch.time.getTime() <= briefWinMs ? lastTouch.id : null;
        open = { contactId, conversationId: ev.convId, status: 'open', stage: 'booked', leadAt: ev.time, qualifiedAt: ev.time, bookedAt: ev.time, attendedAt: null, originTouchId: origin, qualifiedImplicitly: true, lostReason: null, closedAt: null, appointmentIds: [] };
      }
      const o = open!;
      if (o.stage === 'lead' || o.stage === 'qualified') {
        if (o.stage === 'lead') { o.qualifiedImplicitly = true; o.qualifiedAt = o.qualifiedAt ?? ev.time; }
        o.stage = 'booked';
        o.bookedAt = o.bookedAt ?? ev.time;
      }
      if (!o.conversationId) o.conversationId = ev.convId;
      o.appointmentIds.push(ev.apptId);
      if (ev.status === 'completed') { o.stage = 'attended'; o.attendedAt = ev.startAt; o.status = 'won'; o.closedAt = ev.startAt; close(); }
      else if (ev.status === 'no_show') { o.status = 'lost'; o.lostReason = 'no_asistio'; o.closedAt = ev.startAt; close(); }
      else if (ev.status === 'cancelled') { o.stage = 'qualified'; }
      // scheduled/confirmed → stays booked (open)
    }
  }
  close();
  return result;
}

interface ClientRow { tenant_id: string; client_id: string; tracking_started_at: Date; reopen_window_days: number; brief_window_days: number; auto_lost_after_hours: number }

export async function backfillPipeline(opts: { apply?: boolean; tenantId?: string } = {}): Promise<PipelineBackfillSummary> {
  const apply = opts.apply ?? false;
  const summary: PipelineBackfillSummary = {
    apply, clientsProcessed: 0, contactsScanned: 0, opportunitiesCreated: 0, autoLost: 0,
    byStage: { lead: 0, qualified: 0, booked: 0, attended: 0, paid: 0 },
    byStatus: { open: 0, won: 0, lost: 0 },
    byOrigin: {}, byAd: [],
  };
  const adTally = new Map<string, { adExternalId: string; isTest: boolean; count: number }>();

  const clients = await query<ClientRow>(
    `SELECT s.tenant_id, s.client_id, s.tracking_started_at,
            COALESCE(ps.reopen_window_days, 30) AS reopen_window_days,
            COALESCE(s.brief_window_days, 7) AS brief_window_days,
            COALESCE(ps.auto_lost_after_hours, 72) AS auto_lost_after_hours
       FROM attribution_settings s
       LEFT JOIN pipeline_settings ps ON ps.tenant_id = s.tenant_id AND ps.client_id = s.client_id
      WHERE s.tracking_started_at IS NOT NULL ${opts.tenantId ? 'AND s.tenant_id = $1' : ''}`,
    opts.tenantId ? [opts.tenantId] : [],
  );

  for (const c of clients.rows) {
    summary.clientsProcessed += 1;
    const start = c.tracking_started_at;
    const reopenWinMs = c.reopen_window_days * DAY_MS;
    const briefWinMs = c.brief_window_days * DAY_MS;

    // Candidate contacts: this client's contacts with NO opportunity yet (idempotency).
    const candidates = await query<{ id: string; origin_kind: string | null }>(
      `SELECT id, origin_kind FROM contacts c
        WHERE c.tenant_id = $1 AND c.client_id = $2
          AND NOT EXISTS (SELECT 1 FROM opportunities o WHERE o.tenant_id = c.tenant_id AND o.contact_id = c.id)`,
      [c.tenant_id, c.client_id],
    );
    const candidateSet = new Set(candidates.rows.map((r) => r.id));
    const originKind = new Map(candidates.rows.map((r) => [r.id, r.origin_kind]));
    summary.contactsScanned += candidates.rows.length;
    if (candidateSet.size === 0) continue;

    // Facts from tracking start onward.
    const touches = await query<{ id: string; contact_id: string; conversation_id: string | null; occurred_at: Date; ad_id: string; external_id: string; is_test: boolean }>(
      `SELECT t.id, t.contact_id, t.conversation_id, t.occurred_at, t.ad_id, a.external_id, a.is_test
         FROM attribution_touches t JOIN ads a ON a.id = t.ad_id AND a.tenant_id = t.tenant_id
        WHERE t.tenant_id = $1 AND t.client_id = $2 AND t.occurred_at >= $3`,
      [c.tenant_id, c.client_id, start],
    );
    const appts = await query<{ id: string; owner_contact_id: string | null; created_at: Date; status: string; start_at: Date; source_conversation_id: string | null }>(
      `SELECT a.id, COALESCE(cv.contact_id, a.contact_id) AS owner_contact_id, a.created_at, a.status, a.start_at, a.source_conversation_id
         FROM appointments a
         LEFT JOIN conversations cv ON cv.id = a.source_conversation_id AND cv.tenant_id = a.tenant_id
        WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.created_at >= $3`,
      [c.tenant_id, c.client_id, start],
    );
    const firstMsgs = await query<{ contact_id: string; first_at: Date; conv: string }>(
      `SELECT cv.contact_id, min(hm.created_at) AS first_at,
              (array_agg(hm.conversation_id ORDER BY hm.created_at))[1] AS conv
         FROM handoff_messages hm
         JOIN conversations cv ON cv.id = hm.conversation_id AND cv.tenant_id = hm.tenant_id
         JOIN contacts ct ON ct.id = cv.contact_id AND ct.tenant_id = cv.tenant_id AND ct.client_id = $2
        WHERE hm.tenant_id = $1 AND hm.sender = 'user' AND hm.created_at >= $3
        GROUP BY cv.contact_id`,
      [c.tenant_id, c.client_id, start],
    );

    const adForTouch = new Map(touches.rows.map((t) => [t.id, { externalId: t.external_id, isTest: t.is_test }]));
    const touchesByContact = new Map<string, typeof touches.rows>();
    for (const t of touches.rows) {
      if (!candidateSet.has(t.contact_id)) continue;
      (touchesByContact.get(t.contact_id) ?? touchesByContact.set(t.contact_id, []).get(t.contact_id)!).push(t);
    }
    const apptsByOwner = new Map<string, typeof appts.rows>();
    for (const a of appts.rows) {
      if (!a.owner_contact_id || !candidateSet.has(a.owner_contact_id)) continue;
      (apptsByOwner.get(a.owner_contact_id) ?? apptsByOwner.set(a.owner_contact_id, []).get(a.owner_contact_id)!).push(a);
    }
    const firstMsgByContact = new Map(firstMsgs.rows.filter((m) => candidateSet.has(m.contact_id)).map((m) => [m.contact_id, m]));

    // Build + reconstruct per candidate that has ANY activity.
    const built: ReconOpp[] = [];
    for (const contactId of candidateSet) {
      const cTouches = touchesByContact.get(contactId) ?? [];
      const cAppts = apptsByOwner.get(contactId) ?? [];
      const first = firstMsgByContact.get(contactId);
      const events: Ev[] = [];
      for (const t of cTouches) events.push({ type: 'ad', time: t.occurred_at, touchId: t.id, convId: t.conversation_id });
      for (const a of cAppts) events.push({ type: 'booking', time: a.created_at, apptId: a.id, status: a.status, startAt: a.start_at, convId: a.source_conversation_id });
      // Organic opening ONLY for a brand-new contact: a first message, no touch, no appointment.
      if (first && cTouches.length === 0 && cAppts.length === 0) events.push({ type: 'organic', time: first.first_at, convId: first.conv });
      if (events.length === 0) continue;
      events.sort((x, y) => x.time.getTime() - y.time.getTime() || (x.type === 'booking' ? 1 : 0) - (y.type === 'booking' ? 1 : 0));
      built.push(...reconstruct(contactId, events, reopenWinMs, briefWinMs));
    }

    // Auto-lost pass: a still-open lead/qualified sale the business answered last, unanswered too long.
    const openConvIds = [...new Set(built.filter((o) => o.status === 'open' && (o.stage === 'lead' || o.stage === 'qualified') && o.conversationId).map((o) => o.conversationId!))];
    const lastMsg = new Map<string, { sender: string; created_at: Date }>();
    if (openConvIds.length) {
      const lm = await query<{ conversation_id: string; sender: string; created_at: Date }>(
        `SELECT DISTINCT ON (conversation_id) conversation_id, sender, created_at
           FROM handoff_messages WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[])
          ORDER BY conversation_id, created_at DESC, id DESC`,
        [c.tenant_id, openConvIds],
      );
      for (const r of lm.rows) lastMsg.set(r.conversation_id, { sender: r.sender, created_at: r.created_at });
    }
    const now = Date.now();
    for (const o of built) {
      if (o.status === 'open' && (o.stage === 'lead' || o.stage === 'qualified') && o.conversationId) {
        const last = lastMsg.get(o.conversationId);
        if (last && (last.sender === 'bot' || last.sender === 'human_agent') && now - last.created_at.getTime() >= c.auto_lost_after_hours * 3_600_000) {
          o.status = 'lost';
          o.lostReason = 'no_respondio';
          o.closedAt = new Date(now);
          summary.autoLost += 1;
        }
      }
    }

    // Tally + (apply) persist.
    for (const o of built) {
      summary.opportunitiesCreated += 1;
      summary.byStage[o.stage] += 1;
      summary.byStatus[o.status] += 1;
      const ok = originKind.get(o.contactId) ?? 'unknown';
      summary.byOrigin[ok] = (summary.byOrigin[ok] ?? 0) + 1;
      if (o.originTouchId) {
        const ad = adForTouch.get(o.originTouchId);
        if (ad) {
          const key = `${ad.isTest ? 'test:' : ''}${ad.externalId}`;
          const row = adTally.get(key) ?? { adExternalId: ad.externalId, isTest: ad.isTest, count: 0 };
          row.count += 1;
          adTally.set(key, row);
        }
      }
    }

    if (apply && built.length) {
      await withTransaction(async (client) => {
        for (const o of built) {
          // Re-check idempotency inside the tx: never create a second sale for a contact that
          // already has one (live §2 or a concurrent run may have inserted since we scanned).
          const exists = await client.query(`SELECT 1 FROM opportunities WHERE tenant_id = $1 AND contact_id = $2 LIMIT 1`, [c.tenant_id, o.contactId]);
          if ((exists.rowCount ?? 0) > 0) continue;
          const ins = await client.query<{ id: string }>(
            `INSERT INTO opportunities
               (tenant_id, client_id, contact_id, conversation_id, status, stage,
                lead_at, qualified_at, booked_at, attended_at, origin_touch_id, qualified_implicitly,
                qualified_by, lost_reason, closed_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
             RETURNING id`,
            [c.tenant_id, c.client_id, o.contactId, o.conversationId, o.status, o.stage,
              o.leadAt, o.qualifiedAt, o.bookedAt, o.attendedAt, o.originTouchId, o.qualifiedImplicitly,
              o.qualifiedImplicitly ? 'system' : null, o.lostReason, o.closedAt, o.leadAt],
          );
          const oppId = ins.rows[0]!.id;
          await client.query(
            `INSERT INTO opportunity_stage_events (tenant_id, client_id, opportunity_id, from_stage, to_stage, from_status, to_status, actor, reason, occurred_at)
             VALUES ($1,$2,$3,NULL,$4,NULL,$5,'system','backfill',$6)`,
            [c.tenant_id, c.client_id, oppId, o.stage, o.status, o.leadAt],
          );
          if (o.appointmentIds.length) {
            await client.query(`UPDATE appointments SET opportunity_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [c.tenant_id, o.appointmentIds, oppId]);
          }
        }
      });
    }
  }

  summary.byAd = [...adTally.values()].sort((a, b) => b.count - a.count);
  return summary;
}
