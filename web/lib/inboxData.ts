import "server-only";
import { getSessionScope, canAccessClient, type AccessScope } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { listTurnsForConversation } from "@worker/db/repositories/conversationTurns.js";
import {
  ACTIVITY_WINDOW_HOURS,
  getConversationForClient,
  getLatestEscalationReasons,
  listConversationsForClient,
  listConversationsForWorkflow,
  listConversationSchedulingEvents,
  listModeTransitions,
  listThreadMessages,
  type EscalationReasonRow,
  type InboxConversationRow,
  type InboxConversationDetail,
  type ThreadMessageRow,
} from "@worker/db/repositories/handoff.js";
import { parseMessagePayload } from "./inboxView";
import type {
  HistoryTurnView,
  ThreadEventView,
  ThreadSchedulingEventView,
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
 * routes). 401 when unauthenticated; 404 when the client is bogus/foreign, outside a
 * member's scope, OR the `inbox` module is DISABLED for the client (deny-by-default,
 * never disclose existence — the disabled case is indistinguishable from missing).
 */
export async function resolveInboxAccess(clientId: string): Promise<InboxAccess> {
  const scope = await getSessionScope();
  if (!scope) return { ok: false, status: 401 };
  if (!canAccessClient(scope, clientId)) return { ok: false, status: 404 };
  const client = await getClientById({ tenantId: scope.tenantId, clientId });
  if (!client) return { ok: false, status: 404 };
  if (!(await isClientModuleEnabled(scope.tenantId, clientId, "inbox"))) return { ok: false, status: 404 };
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
    contactName: r.contact_name,
    contactVisitCount: r.contact_visit_count,
    channel: r.contact_channel,
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
    // Defensive by construction — `metadata` is an unknown jsonb column and a malformed
    // payload must degrade to a plain text message, never break the thread.
    payload: parseMessagePayload(m.metadata),
  };
}

export function toHeaderView(
  c: InboxConversationDetail,
  windowHours: number = ACTIVITY_WINDOW_HOURS,
): InboxHeaderView {
  const active = c.last_user_message_at
    ? Date.now() - c.last_user_message_at.getTime() <= windowHours * 3600_000
    : false;
  return {
    id: c.id,
    conversationRef: c.conversation_ref,
    workflowName: c.workflow_name,
    mode: c.mode,
    active,
    lastUserMessageAt: c.last_user_message_at?.toISOString() ?? null,
    assignedAgentUserId: c.assigned_agent_user_id,
    assignedAgentName: c.assigned_agent_name,
    contactName: c.contact_name,
    channel: c.contact_channel,
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

/**
 * Load a CLIENT's UNIFIED inbox list (Phase 4A): the live/handoff conversations of
 * ALL the client's canonical workflows, in the same wire shape as the per-workflow
 * list (each row carries workflowId + workflowName so the grid can show and filter
 * by workflow). The latest escalation reason is attached to PENDING rows via ONE
 * batched query. Caller MUST pass a tenant+client the session is authorized for
 * (resolveInboxAccess / getClientForTenant).
 */
export async function loadClientInboxList(
  tenantId: string,
  clientId: string,
): Promise<WorkflowInboxPayload> {
  const rows = await listConversationsForClient(tenantId, clientId);
  const pendingIds = rows.filter((r) => r.mode === "pending").map((r) => r.id);
  const reasons = await getLatestEscalationReasons(tenantId, pendingIds);
  return {
    conversations: rows.map((r) => toConversationView(r, reasons.get(r.id))),
    activityWindowHours: ACTIVITY_WINDOW_HOURS,
    asOf: new Date().toISOString(),
  };
}

/**
 * Load a client's inbox list SCOPED to the current workflow (W-2): 'all' ⇒ the whole
 * client (loadClientInboxList); a workflow id ⇒ just that workflow's conversations
 * (loadWorkflowInboxList). The caller MUST have already validated that `scope` (when a
 * workflow id) belongs to `clientId` and is accessible (the page/route resolve it via
 * resolveWorkflowScope / validateWorkflowForClient). Filtering at THIS data layer keeps
 * the list's groups, counts, and pending badge correct for the scoped set.
 */
export async function loadScopedClientInbox(
  tenantId: string,
  clientId: string,
  scope: "all" | string,
): Promise<WorkflowInboxPayload> {
  return scope === "all"
    ? loadClientInboxList(tenantId, clientId)
    : loadWorkflowInboxList(tenantId, scope);
}

export interface InboxThreadPayload {
  header: InboxHeaderView;
  messages: InboxMessageView[];
  /** Pre-handoff derived turns (only when requested — for the drawer's initial load). */
  history?: HistoryTurnView[];
  /** Mode turning points, interleaved with the messages by the thread. Loaded on the
   *  POLL too, not just the first open: a colleague taking the conversation over must
   *  appear in your thread within the poll interval, not on your next reload. */
  events: ThreadEventView[];
  /** Scheduling turning points — the appointment this conversation booked, and what has
   *  happened to it since. Loaded on the POLL too: a customer who reschedules through the
   *  bot must show up in an open thread within the poll interval. */
  schedulingEvents: ThreadSchedulingEventView[];
  activityWindowHours: number;
  asOf: string;
}

/**
 * Load a thread (header + messages, serialized) — but ONLY if the conversation
 * belongs to this client. Returns null otherwise (→ the caller 404s / direct-URL
 * probing of another client's conversation is indistinguishable from not-found).
 * `includeHistory` adds the pre-handoff derived turns (one extra query) — the drawer
 * requests it on the initial open; the ~4s poll does not.
 */
export async function loadInboxThread(
  tenantId: string,
  clientId: string,
  conversationId: string,
  opts: { includeHistory?: boolean } = {},
): Promise<InboxThreadPayload | null> {
  if (!isUuid(conversationId)) return null; // never let a non-UUID reach the id= query
  const conversation = await getConversationForClient(tenantId, clientId, conversationId);
  if (!conversation) return null;
  const [messages, transitions, scheduling] = await Promise.all([
    listThreadMessages(tenantId, conversationId),
    listModeTransitions(tenantId, conversationId),
    listConversationSchedulingEvents(tenantId, clientId, conversationId),
  ]);

  let history: HistoryTurnView[] | undefined;
  if (opts.includeHistory) {
    const turns = await listTurnsForConversation({
      tenantId,
      n8nWorkflowId: conversation.n8n_workflow_id,
      conversationId: conversation.conversation_ref,
    });
    history = turns.map((t) => ({
      id: t.id,
      userText: t.user_message,
      aiText: t.ai_response,
      at: t.turn_timestamp.toISOString(),
    }));
  }

  return {
    header: toHeaderView(conversation),
    messages: messages.map(toMessageView),
    events: transitions.map((t) => ({
      id: t.id,
      fromMode: t.from_mode,
      toMode: t.to_mode,
      agentName: t.agent_name,
      at: t.created_at.toISOString(),
    })),
    schedulingEvents: scheduling.map((e) => ({
      id: e.id,
      appointmentId: e.appointment_id,
      eventType: e.event_type,
      actorType: e.actor_type,
      actorName: e.actor_name,
      serviceName: e.service_name,
      startAt: e.start_at.toISOString(),
      staffName: e.staff_name,
      status: e.status,
      at: e.created_at.toISOString(),
    })),
    history,
    activityWindowHours: ACTIVITY_WINDOW_HOURS,
    asOf: new Date().toISOString(),
  };
}
