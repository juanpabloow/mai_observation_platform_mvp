import "server-only";
import { getSessionScope, canAccessClient, type AccessScope } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import { getWorkflowByN8nId } from "@worker/db/repositories/workflows.js";
import {
  ACTIVITY_WINDOW_HOURS,
  getConversationForClient,
  getLatestEscalationReasons,
  listConversationsForWorkflow,
  listThreadMessages,
  type EscalationReasonRow,
  type InboxConversationRow,
  type InboxConversationDetail,
  type ThreadMessageRow,
} from "@worker/db/repositories/handoff.js";
import type {
  InboxConversationView,
  InboxHeaderView,
  InboxMessageView,
} from "./inboxView";

/** UUID guard so a non-UUID conversation id (e.g. a derived ref) never reaches a
 * `id = $` query and triggers a Postgres uuid-cast error on probing. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Server-side inbox data layer: resolves access for the session-authed JSON polling
 * routes (NON-redirecting, unlike the page helpers) and loads/serializes inbox data
 * into the client-safe wire shapes. Shared by the SSR pages and the poll routes so
 * both return identical shapes. This is NOT the machine handoff API.
 */

export type InboxAccess =
  | { ok: true; scope: AccessScope }
  | { ok: false; status: 401 | 404 };

/**
 * Authorize a session user for a client's inbox WITHOUT redirecting (for JSON
 * routes). 401 when unauthenticated; 404 when the client is bogus/foreign or
 * outside a member's scope (deny-by-default, never disclose existence).
 */
export async function resolveInboxAccess(clientId: string): Promise<InboxAccess> {
  const scope = await getSessionScope();
  if (!scope) return { ok: false, status: 401 };
  if (!canAccessClient(scope, clientId)) return { ok: false, status: 404 };
  const client = await getClientById({ tenantId: scope.tenantId, clientId });
  if (!client) return { ok: false, status: 404 };
  return { ok: true, scope };
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function toConversationView(
  r: InboxConversationRow,
  reason?: EscalationReasonRow,
): InboxConversationView {
  return {
    id: r.id,
    conversationRef: r.conversation_ref,
    workflowId: r.n8n_workflow_id,
    workflowName: r.workflow_name,
    mode: r.mode,
    active: r.active,
    assignedAgentName: r.assigned_agent_name,
    lastMessageText: r.last_message_text,
    lastMessageSender: r.last_message_sender,
    lastMessageContentType: r.last_message_content_type,
    lastMessageAt: iso(r.last_message_at),
    createdAt: r.created_at.toISOString(),
    pendingSince: iso(r.pending_since),
    // Escalation reason is attached only for pending cards (batched, see loader).
    escalationReasonCode: reason?.reason_code ?? null,
    escalationDetail: reason?.detail ?? null,
  };
}

export function toMessageView(m: ThreadMessageRow): InboxMessageView {
  return {
    id: m.id,
    sender: m.sender,
    agentName: m.agent_name,
    text: m.text,
    contentType: m.content_type,
    status: m.status,
    failureCode: m.failure_code,
    failureDetail: m.failure_detail,
    occurredAt: m.occurred_at.toISOString(),
  };
}

export function toHeaderView(c: InboxConversationDetail): InboxHeaderView {
  return {
    id: c.id,
    conversationRef: c.conversation_ref,
    workflowName: c.workflow_name,
    mode: c.mode,
    assignedAgentUserId: c.assigned_agent_user_id,
    assignedAgentName: c.assigned_agent_name,
  };
}

export interface WorkflowInboxPayload {
  conversations: InboxConversationView[];
  /** The activity threshold (hours) — surfaced so the client tooltip stays in sync. */
  activityWindowHours: number;
  asOf: string;
}

/**
 * Load a single WORKFLOW's full conversation list for the grid (H-7). Returns ALL
 * conversations (the grid does mode/activity/search filtering + live counts
 * client-side). Each row carries the SQL-computed `active` flag; the latest escalation
 * reason is attached to PENDING rows via ONE batched query (never a per-card lateral).
 */
export async function loadWorkflowInboxList(
  tenantId: string,
  n8nWorkflowId: string,
): Promise<WorkflowInboxPayload> {
  const rows = await listConversationsForWorkflow(tenantId, n8nWorkflowId);
  const pendingIds = rows.filter((r) => r.mode === "pending").map((r) => r.id);
  const reasons = await getLatestEscalationReasons(tenantId, pendingIds);
  return {
    conversations: rows.map((r) => toConversationView(r, reasons.get(r.id))),
    activityWindowHours: ACTIVITY_WINDOW_HOURS,
    asOf: new Date().toISOString(),
  };
}

export type WorkflowInboxAccess =
  | { ok: true; scope: AccessScope }
  | { ok: false; status: 401 | 404 };

/**
 * Authorize a session user for a WORKFLOW's inbox (JSON routes, non-redirecting):
 * the workflow must be this tenant's, and its real client must be accessible to the
 * user. 401 unauthenticated; 404 for a foreign/bogus workflow or one outside a
 * member's client scope (deny-by-default).
 */
export async function resolveWorkflowInboxAccess(
  n8nWorkflowId: string,
): Promise<WorkflowInboxAccess> {
  const scope = await getSessionScope();
  if (!scope) return { ok: false, status: 401 };
  const workflow = await getWorkflowByN8nId({ tenantId: scope.tenantId, n8nWorkflowId });
  if (!workflow || !workflow.client_id) return { ok: false, status: 404 };
  if (!canAccessClient(scope, workflow.client_id)) return { ok: false, status: 404 };
  return { ok: true, scope };
}

export interface InboxThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
  asOf: string;
}

/**
 * Load a thread (header + messages, serialized) — but ONLY if the conversation
 * belongs to this client. Returns null otherwise (→ the caller 404s / direct-URL
 * probing of another client's conversation is indistinguishable from not-found).
 */
export async function loadInboxThread(
  tenantId: string,
  clientId: string,
  conversationId: string,
): Promise<InboxThreadPayload | null> {
  if (!isUuid(conversationId)) return null; // never let a non-UUID reach the id= query
  const conversation = await getConversationForClient(tenantId, clientId, conversationId);
  if (!conversation) return null;
  const messages = await listThreadMessages(tenantId, conversationId);
  return {
    header: toHeaderView(conversation),
    messages: messages.map(toMessageView),
    asOf: new Date().toISOString(),
  };
}
