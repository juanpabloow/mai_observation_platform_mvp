import { query, withTransaction } from '../client.js';

/**
 * ID-H §4 — DETECT AND CONTAIN collapsed identities, never guess.
 *
 * Before the workflow's phone/BSUID fallback existed, a user without a phone could reach the
 * platform with an empty or sentinel identifier ("undefined"), collapsing strangers into one
 * conversation and one contact (the Q1–Q4 defect). The §1 guards stop NEW collapses; this
 * module finds and contains EXISTING ones. It does not re-attribute messages (there is no
 * per-message field that reliably identifies the real sender — see the script's note), so the
 * only safe repair is QUARANTINE: re-key the conversation to an unmatchable `quarantined:<uuid>`
 * ref and detach the shared sentinel contact (drop its sentinel identities, re-key its
 * channel_user_id) so no future message can ever join it. The data is kept for human review.
 */

// The sentinel predicate in SQL — mirrors isSentinelIdentifier (identity/sentinel.ts). A
// constant shape; `col` is only ever a trusted column name, never user input.
const WORD_LIST = `('undefined','null','nan','none','true','false','[object object]')`;
/** Identity/ref value is a sentinel: empty OR a placeholder word OR an unrendered/literal n8n expr. */
const identSentinelSql = (col: string) =>
  `(btrim(${col}) = '' OR lower(btrim(${col})) IN ${WORD_LIST} OR ${col} LIKE '%{{%' OR ${col} LIKE '=%')`;
/** channel_user_id is a sentinel WORD/expression — deliberately NOT plain null/empty (a contact
 *  created by phone legitimately has no channel_user_id). */
const cuidSentinelSql = (col: string) =>
  `(lower(btrim(${col})) IN ${WORD_LIST} OR ${col} LIKE '%{{%' OR ${col} LIKE '=%')`;

/** A BSUID shape in SQL (CC.<id> or CC.ENT.<id>), for the legacy invented-phone report. */
const BSUID_SQL = `'^[[:space:]]*[A-Za-z]{2}([.][A-Za-z0-9]+)+[[:space:]]*$'`;

export interface SentinelConversation {
  id: string;
  tenant_id: string;
  n8n_workflow_id: string;
  conversation_ref: string;
  contact_id: string | null;
  distinct_contacts: number; // how many DISTINCT contacts messaged under this ref (>1 = mixed strangers)
}

export interface SentinelContact {
  id: string;
  tenant_id: string;
  client_id: string;
  channel: string;
  channel_user_id: string | null;
  sentinel_identity_values: string[];
}

export interface ContainmentReport {
  conversations: SentinelConversation[];
  contacts: SentinelContact[];
  /** Legacy contacts whose channel_user_id is a BSUID (the pre-1444d5a invented-phone class);
   *  informational — these are ONE real person each, NOT a collapse, so they are NOT contained. */
  legacyBsuidContacts: number;
}

/** Read-only detection of collapsed/sentinel identity state (Q1–Q4 logic). Scoped to one tenant
 *  when given, else the whole database (the operator runs it in the Railway console). */
export async function detectCollapsedIdentity(opts: { tenantId?: string } = {}): Promise<ContainmentReport> {
  const tenantFilter = opts.tenantId ? 'AND c.tenant_id = $1' : '';
  const params = opts.tenantId ? [opts.tenantId] : [];

  const conversations = (
    await query<SentinelConversation>(
      `SELECT c.id, c.tenant_id, c.n8n_workflow_id, c.conversation_ref, c.contact_id,
              (SELECT count(DISTINCT x.contact_id)::int
                 FROM conversations x
                WHERE x.tenant_id = c.tenant_id AND x.n8n_workflow_id = c.n8n_workflow_id
                  AND x.conversation_ref = c.conversation_ref AND x.contact_id IS NOT NULL) AS distinct_contacts
         FROM conversations c
        WHERE ${identSentinelSql('c.conversation_ref')} ${tenantFilter}
        ORDER BY c.tenant_id, c.conversation_ref`,
      params,
    )
  ).rows;

  const contacts = (
    await query<SentinelContact>(
      `SELECT c.id, c.tenant_id, c.client_id, c.channel, c.channel_user_id,
              COALESCE(
                (SELECT array_agg(DISTINCT ci.value)
                   FROM contact_identities ci
                  WHERE ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id AND ci.contact_id = c.id
                    AND ${identSentinelSql('ci.value')}),
                '{}') AS sentinel_identity_values
         FROM contacts c
        WHERE (${cuidSentinelSql('c.channel_user_id')}
               OR EXISTS (SELECT 1 FROM contact_identities ci
                           WHERE ci.tenant_id = c.tenant_id AND ci.client_id = c.client_id AND ci.contact_id = c.id
                             AND ${identSentinelSql('ci.value')}))
          ${tenantFilter}
        ORDER BY c.tenant_id, c.client_id, c.id`,
      params,
    )
  ).rows;

  const legacy = (
    await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contacts c
        WHERE c.channel_user_id ~ ${BSUID_SQL} ${tenantFilter}`,
      params,
    )
  ).rows[0]?.n ?? 0;

  return { conversations, contacts, legacyBsuidContacts: legacy };
}

export interface ContainmentResult {
  quarantinedConversations: number;
  detachedContacts: number;
}

/**
 * Apply containment for a previously-detected report, in ONE transaction. Quarantines each
 * sentinel conversation (unmatchable ref + detached contact) and neutralizes each sentinel
 * contact (sentinel identities removed, channel_user_id re-keyed) so it can never be re-matched.
 * Idempotent: re-running after a run finds nothing left to contain.
 */
export async function applyContainment(report: ContainmentReport): Promise<ContainmentResult> {
  if (report.conversations.length === 0 && report.contacts.length === 0) {
    return { quarantinedConversations: 0, detachedContacts: 0 };
  }
  return withTransaction(async (client) => {
    let quarantinedConversations = 0;
    for (const conv of report.conversations) {
      const r = await client.query(
        `UPDATE conversations
            SET conversation_ref = 'quarantined:' || gen_random_uuid(), contact_id = NULL, updated_at = now()
          WHERE id = $1 AND tenant_id = $2`,
        [conv.id, conv.tenant_id],
      );
      quarantinedConversations += r.rowCount ?? 0;
    }
    let detachedContacts = 0;
    for (const ct of report.contacts) {
      await client.query(
        `DELETE FROM contact_identities
          WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3 AND ${identSentinelSql('value')}`,
        [ct.tenant_id, ct.client_id, ct.id],
      );
      const r = await client.query(
        `UPDATE contacts
            SET channel_user_id = 'quarantined:' || id::text, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
        [ct.id, ct.tenant_id, ct.client_id],
      );
      detachedContacts += r.rowCount ?? 0;
    }
    return { quarantinedConversations, detachedContacts };
  });
}
