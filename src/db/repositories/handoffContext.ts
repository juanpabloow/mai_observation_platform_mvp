import { query } from '../client.js';
import {
  CONTEXT_MESSAGE_CHARS, CONTEXT_MESSAGE_LIMIT,
  projectConversationContext, type ContextSnapshot,
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
