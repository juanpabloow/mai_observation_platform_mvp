import { query, withTransaction } from '../db/client.js';
import { classifyContactOrigin, setContactOrigin, type OriginKind } from '../db/repositories/attribution.js';
import { parseReferral, registerAdAndTouch, type ReferralInput } from './ingest.js';

// Re-exported for existing importers (the pure rule now lives with decideInboundOrigin in the
// attribution repo, so the live path and the backfill share ONE definition).
export { classifyContactOrigin };

/**
 * AT-1 §3/§4 — the shared attribution ENGINE. The worker reconciliation job and the
 * `attribution:backfill` CLI both call this; it is idempotent (a second run is a no-op) and
 * supports a DRY RUN (apply=false writes nothing, returns the same counts a real run would).
 *
 * It does two things, FACTS ONLY:
 *   1. TOUCHES — every stored inbound USER message with a valid referral whose conversation has
 *      a contact and no touch yet → register/refresh the ad + write the touch.
 *   2. ORIGINS — every contact whose origin is still PROVISIONAL (unset, or an automation-set
 *      'unknown' — "couldn't tell yet") → (re)classify from facts via the shared
 *      classifyContactOrigin. Revisiting a provisional 'unknown' is deliberate: when a fact
 *      arrives late — a corrected attribution_tracking_started_at, or a contact created by the
 *      CRM /contacts/upsert "sync profile" node a moment before its first message — the earlier
 *      'unknown' must be upgraded (e.g. → organic_whatsapp). A write is only made when the origin
 *      actually CHANGES, so a quiet pass (and repeated reconcile runs) writes nothing and adds no
 *      timeline churn. A HUMAN-set origin (manual, or a human-reviewed merge) is NEVER revisited.
 * booked_by_contact and import are produced at creation time, never guessed here.
 */

export interface AttributionBackfillSummary {
  apply: boolean;
  referralMessagesLinked: number;
  touchesWritten: number;
  touchesAlreadyPresent: number;
  invalidReferrals: number;
  referralMessagesNoContact: number;
  originsSet: number;
  byOrigin: Record<string, number>;
  byAd: Array<{ external_id: string; source_type: string; is_test: boolean; touches: number }>;
}

interface MsgRow {
  message_id: string;
  tenant_id: string;
  client_id: string;
  contact_id: string | null;
  conversation_id: string;
  occurred_at: Date;
  metadata: Record<string, unknown> | null;
  has_touch: boolean;
}

interface OriginContactRow {
  id: string;
  tenant_id: string;
  client_id: string;
  channel: string;
  origin_kind: OriginKind | null;
  tracking_started_at: Date | null;
  first_msg_at: Date | null;
  first_msg_metadata: Record<string, unknown> | null;
}

function tenantFilter(tenantId: string | undefined, col: string, params: unknown[]): string {
  if (!tenantId) return '';
  params.push(tenantId);
  return ` AND ${col} = $${params.length}`;
}

/** All inbound user messages that carry referral keys, with their client + contact + touch state. */
async function loadReferralMessages(tenantId?: string): Promise<MsgRow[]> {
  const params: unknown[] = [];
  const filter = tenantFilter(tenantId, 'm.tenant_id', params);
  const r = await query<MsgRow>(
    `SELECT m.id AS message_id, m.tenant_id, w.client_id, c.contact_id,
            c.id AS conversation_id, m.occurred_at, m.metadata,
            (t.id IS NOT NULL) AS has_touch
       FROM handoff_messages m
       JOIN conversations c ON c.id = m.conversation_id
       JOIN workflows w ON w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
       LEFT JOIN attribution_touches t ON t.message_id = m.id
      WHERE m.sender = 'user' AND m.metadata ? 'referral_source_id'${filter}
      ORDER BY m.occurred_at ASC, m.id ASC`,
    params,
  );
  return r.rows;
}

/**
 * Contacts whose origin is still PROVISIONAL — unset, or an automation-set 'unknown'
 * (origin_set_by NULL or 'system') — with the facts needed to (re)classify them. A human-set
 * origin (origin_set_by = a user id) is excluded: automation never revisits a person's decision.
 */
async function loadUnclassifiedContacts(tenantId?: string): Promise<OriginContactRow[]> {
  const params: unknown[] = [];
  const filter = tenantFilter(tenantId, 'ct.tenant_id', params);
  const r = await query<OriginContactRow>(
    `SELECT ct.id, ct.tenant_id, ct.client_id, ct.channel, ct.origin_kind, s.tracking_started_at,
            fm.occurred_at AS first_msg_at, fm.metadata AS first_msg_metadata
       FROM contacts ct
       LEFT JOIN attribution_settings s ON s.tenant_id = ct.tenant_id AND s.client_id = ct.client_id
       LEFT JOIN LATERAL (
         SELECT m.occurred_at, m.metadata
           FROM handoff_messages m
           JOIN conversations cv ON cv.id = m.conversation_id
          WHERE cv.contact_id = ct.id AND m.sender = 'user'
          ORDER BY m.occurred_at ASC, m.id ASC LIMIT 1) fm ON true
      WHERE (ct.origin_kind IS NULL
             OR (ct.origin_kind = 'unknown' AND (ct.origin_set_by IS NULL OR ct.origin_set_by = 'system')))${filter}`,
    params,
  );
  return r.rows;
}

export async function backfillAttribution(opts: { tenantId?: string; apply: boolean }): Promise<AttributionBackfillSummary> {
  const messages = await loadReferralMessages(opts.tenantId);
  const contacts = await loadUnclassifiedContacts(opts.tenantId);

  const summary: AttributionBackfillSummary = {
    apply: opts.apply,
    referralMessagesLinked: 0,
    touchesWritten: 0,
    touchesAlreadyPresent: 0,
    invalidReferrals: 0,
    referralMessagesNoContact: 0,
    originsSet: 0,
    byOrigin: {},
    byAd: [],
  };
  const adTally = new Map<string, { source_type: string; is_test: boolean; touches: number }>();
  const bumpOrigin = (k: OriginKind) => { summary.byOrigin[k] = (summary.byOrigin[k] ?? 0) + 1; };

  // ── Plan the touches (and validate referrals) ──
  const toWrite: Array<{ row: MsgRow; referral: ReferralInput }> = [];
  for (const m of messages) {
    const parsed = parseReferral(m.metadata);
    if (!parsed.present) continue; // defensive (query already filtered on the key)
    if (!parsed.ok) { summary.invalidReferrals += 1; continue; }
    if (!m.contact_id) { summary.referralMessagesNoContact += 1; continue; }
    summary.referralMessagesLinked += 1;
    if (m.has_touch) { summary.touchesAlreadyPresent += 1; continue; }
    toWrite.push({ row: m, referral: parsed.value });
    const key = `${parsed.value.sourceType}:${parsed.value.sourceId}`;
    const t = adTally.get(key) ?? { source_type: parsed.value.sourceType, is_test: parsed.value.sourceId.startsWith('TEST-'), touches: 0 };
    t.touches += 1;
    adTally.set(key, t);
  }
  summary.touchesWritten = toWrite.length;
  summary.byAd = [...adTally.entries()].map(([k, v]) => ({ external_id: k.split(':').slice(1).join(':'), source_type: v.source_type, is_test: v.is_test, touches: v.touches }));

  // ── Plan the origins (only where the origin actually CHANGES) ──
  const originPlan: Array<{ row: OriginContactRow; origin: OriginKind }> = [];
  for (const ct of contacts) {
    const parsed = parseReferral(ct.first_msg_metadata);
    const firstReferral = parsed.present && parsed.ok ? parsed.value : null;
    const origin = classifyContactOrigin({
      channel: ct.channel,
      trackingStartedAt: ct.tracking_started_at,
      firstMsgAt: ct.first_msg_at,
      firstReferral,
    });
    // A provisional 'unknown' that still classifies 'unknown' is a no-op — don't rewrite it (that
    // would churn the timeline on every reconcile pass). Only a genuine change counts/writes.
    if (origin === ct.origin_kind) continue;
    originPlan.push({ row: ct, origin });
    bumpOrigin(origin);
  }
  summary.originsSet = originPlan.length;

  if (!opts.apply) return summary;

  // ── Apply (idempotent) ──
  for (const { row, referral } of toWrite) {
    await withTransaction(async (client) => {
      await registerAdAndTouch(client, {
        tenantId: row.tenant_id,
        clientId: row.client_id,
        contactId: row.contact_id!,
        conversationId: row.conversation_id,
        messageId: row.message_id,
        occurredAt: row.occurred_at,
        referral,
      });
    });
  }
  for (const { row, origin } of originPlan) {
    // For an ad origin, first_touch = the contact's earliest touch (now written above).
    let firstTouchId: string | null = null;
    let latestTouchId: string | null = null;
    if (origin === 'meta_ad' || origin === 'meta_post') {
      firstTouchId = (await query<{ id: string }>(
        `SELECT id FROM attribution_touches WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3 ORDER BY occurred_at ASC, id ASC LIMIT 1`,
        [row.tenant_id, row.client_id, row.id])).rows[0]?.id ?? null;
      latestTouchId = (await query<{ id: string }>(
        `SELECT id FROM attribution_touches WHERE tenant_id=$1 AND client_id=$2 AND contact_id=$3 ORDER BY occurred_at DESC, id DESC LIMIT 1`,
        [row.tenant_id, row.client_id, row.id])).rows[0]?.id ?? null;
    }
    await setContactOrigin({
      tenantId: row.tenant_id,
      clientId: row.client_id,
      contactId: row.id,
      originKind: origin,
      firstTouchId,
      latestTouchId,
      setBy: 'system',
      // Unset OR a provisional (automation-set) 'unknown'. A captured ad origin or a human's
      // decision is never in reach (setContactOrigin's automation guard also protects it).
      overwritable: ['unknown'],
    });
  }
  return summary;
}
