import { query } from '../client.js';
import { isSentinelIdentifier, isQuarantinedRef } from '../../identity/sentinel.js';
import {
  CONTEXT_MESSAGE_CHARS, CONTEXT_MESSAGE_LIMIT,
  projectConversationContext, projectConversationOrigin,
  type ContextOrigin, type ContextSnapshot, type OriginSnapshot,
} from '../../handoff/context.js';

export interface ContextReadScope {
  tenantId: string;
  connectionId: string;
  clientId: string;
  workflowRef: string;
  conversationRef: string;
  throughMessageId: string;
}

/**
 * One read-only SQL snapshot for scope, mode, transition and history. Never creates
 * a conversation. The anchor must be an inbound customer message of THIS thread.
 * The current inbound is excluded (the workflow supplies it separately).
 * Conversation rows lack connection_id: ambiguous workflow refs across connections
 * or clients must fail closed, not let either token read an ambiguous thread.
 */
export async function readConversationContext(scope: ContextReadScope) {
  // ID-H §1 defense in depth: a sentinel-keyed or quarantined conversation is never readable —
  // history must never leak out of a collapsed/contained thread, even with a valid anchor.
  if (isSentinelIdentifier(scope.conversationRef) || isQuarantinedRef(scope.conversationRef)) return null;
  const result = await query<ContextSnapshot>(
    `WITH scoped AS (
       SELECT c.id, c.tenant_id, c.mode, a.id AS anchor_id, a.created_at AS anchor_at
         FROM conversations c
         JOIN workflows w ON w.tenant_id = c.tenant_id
          AND w.n8n_workflow_id = c.n8n_workflow_id
          AND w.n8n_connection_id = $2 AND w.client_id = $3
         JOIN clients cl ON cl.id = w.client_id AND cl.tenant_id = c.tenant_id AND NOT cl.is_default
         JOIN handoff_messages a ON a.tenant_id = c.tenant_id AND a.conversation_id = c.id
          AND a.id = $6 AND a.sender = 'user' AND a.status = 'received'
          AND a.content_type = 'text'
        WHERE c.tenant_id = $1 AND c.n8n_workflow_id = $4 AND c.conversation_ref = $5
          AND EXISTS (SELECT 1 FROM client_modules cm
                       WHERE cm.tenant_id = c.tenant_id AND cm.client_id = $3
                         AND cm.module_key = 'inbox' AND cm.enabled)
          AND NOT EXISTS (SELECT 1 FROM workflows other
                           WHERE other.tenant_id = c.tenant_id
                             AND other.n8n_workflow_id = c.n8n_workflow_id
                             AND (other.n8n_connection_id <> $2 OR other.client_id <> $3))
        LIMIT 1
     )
     SELECT s.id AS conversation_id, s.mode, s.anchor_id AS through_message_id,
            t.latest_transition,
            COALESCE(h.messages, '[]'::jsonb) AS messages
       FROM scoped s
       LEFT JOIN LATERAL (
         SELECT jsonb_build_object('id', tr.id, 'from_mode', tr.from_mode,
                  'to_mode', tr.to_mode, 'at', tr.created_at) AS latest_transition
           FROM conversation_mode_transitions tr
          WHERE tr.tenant_id = s.tenant_id AND tr.conversation_id = s.id
          ORDER BY tr.created_at DESC, tr.id DESC LIMIT 1
       ) t ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object('id', m.id, 'sender', m.sender,
                  'text', m.text, 'occurred_at', m.occurred_at, 'recorded_at', m.created_at,
                  'text_truncated', m.text_truncated)
                  ORDER BY m.created_at DESC, m.id DESC) AS messages
           FROM (
             SELECT hm.id, hm.sender, left(hm.text, $7) AS text,
                    hm.occurred_at, hm.created_at,
                    char_length(hm.text) > $7 AS text_truncated
               FROM handoff_messages hm
              WHERE s.mode = 'bot' AND hm.tenant_id = s.tenant_id AND hm.conversation_id = s.id
                AND (hm.created_at, hm.id) < (s.anchor_at, s.anchor_id)
                AND hm.content_type = 'text' AND hm.text IS NOT NULL AND btrim(hm.text) <> ''
                AND ((hm.sender IN ('user', 'bot') AND hm.status IN ('received', 'sent'))
                  OR (hm.sender = 'human_agent' AND hm.status = 'sent'))
              ORDER BY hm.created_at DESC, hm.id DESC LIMIT $8
           ) m
       ) h ON true`,
    [scope.tenantId, scope.connectionId, scope.clientId, scope.workflowRef,
      scope.conversationRef, scope.throughMessageId, CONTEXT_MESSAGE_CHARS,
      CONTEXT_MESSAGE_LIMIT + 1],
  );
  return result.rows[0] ? projectConversationContext(result.rows[0]) : null;
}

export interface OriginReadScope {
  tenantId: string;
  clientId: string;
  /** The ALREADY-RESOLVED internal conversation id (from readConversationContext). */
  conversationId: string;
}

/**
 * AT-3 — the `origin` block for an already-resolved conversation. The caller resolves (and fully
 * gates) the conversation with readConversationContext FIRST and passes the resulting
 * conversation_id here, so every /context fail-closed rule (sentinel/quarantine refused, anchor
 * proof, workflow + inbox scope) is inherited — this never runs for a conversation that failed
 * them. Returns the block, or null when it must be absent:
 *   - the campaigns module is OFF for the client (an EXISTS gate in SQL), OR
 *   - the conversation's contact has no AD TOUCH inside the brief window.
 *
 * Decided by the TOUCH, never by origin_kind: an existing contact who clicks an ad keeps origin
 * unknown/organic by design, yet that conversation came from the ad and must get the brief. The
 * window is attribution_settings.brief_window_days (default 7). A TEST ad's touch is ignored
 * unless it happened on THIS conversation (the conversation itself came from the test ad). The
 * MOST RECENT qualifying touch wins. ctwa_clid and every external/internal id stay in the
 * database — the projected block carries only what the bot needs.
 */
export async function readConversationOrigin(scope: OriginReadScope): Promise<ContextOrigin | null> {
  const result = await query<OriginSnapshot>(
    `WITH win AS (
       SELECT COALESCE(
         (SELECT brief_window_days FROM attribution_settings WHERE tenant_id = $1 AND client_id = $2),
         7) AS days
     )
     SELECT a.source_type,
            a.name AS ad_name, a.headline AS ad_headline, a.body AS ad_body, a.bot_note AS ad_bot_note,
            c.name AS campaign_name, c.bot_brief AS campaign_bot_brief,
            svc.id AS service_id, svc.name AS service_name,
            promo.name AS promo_title, promo.description AS promo_description
       FROM conversations conv
       JOIN attribution_touches t
         ON t.tenant_id = conv.tenant_id AND t.contact_id = conv.contact_id
       JOIN ads a ON a.id = t.ad_id AND a.tenant_id = conv.tenant_id
       CROSS JOIN win
       LEFT JOIN campaigns c ON c.id = a.campaign_id AND c.tenant_id = conv.tenant_id
       LEFT JOIN services svc ON svc.id = c.target_service_id AND svc.tenant_id = conv.tenant_id
       LEFT JOIN promotions promo ON promo.id = c.promotion_id AND promo.tenant_id = conv.tenant_id
      WHERE conv.id = $3 AND conv.tenant_id = $1 AND t.client_id = $2
        AND t.occurred_at >= now() - make_interval(days => win.days)
        -- a test ad counts ONLY when THIS conversation itself came from it.
        AND (a.is_test = false OR t.conversation_id = $3)
        -- the block only exists when the campaigns module is ON for the client.
        AND EXISTS (SELECT 1 FROM client_modules cm
                     WHERE cm.tenant_id = $1 AND cm.client_id = $2
                       AND cm.module_key = 'campaigns' AND cm.enabled)
      ORDER BY t.occurred_at DESC, t.id DESC
      LIMIT 1`,
    [scope.tenantId, scope.clientId, scope.conversationId],
  );
  return result.rows[0] ? projectConversationOrigin(result.rows[0]) : null;
}
