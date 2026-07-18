import "server-only";
import { getSessionScope, canAccessClient, type AccessScope } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  countPendingForClient,
  getConversationForClient,
  listConversationsForClient,
  listThreadMessages,
  type InboxConversationRow,
  type InboxConversationDetail,
  type ThreadMessageRow,
} from "@worker/db/repositories/handoff.js";
import type {
  InboxConversationView,
  InboxFilter,
  InboxHeaderView,
  InboxMessageView,
} from "./inboxView";

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

function toConversationView(r: InboxConversationRow): InboxConversationView {
  return {
    id: r.id,
    conversationRef: r.conversation_ref,
    workflowName: r.workflow_name,
    mode: r.mode,
    assignedAgentName: r.assigned_agent_name,
    lastMessageText: r.last_message_text,
    lastMessageSender: r.last_message_sender,
    lastMessageContentType: r.last_message_content_type,
    lastMessageAt: iso(r.last_message_at),
    createdAt: r.created_at.toISOString(),
    pendingSince: iso(r.pending_since),
  };
}

function toMessageView(m: ThreadMessageRow): InboxMessageView {
  return {
    id: m.id,
    sender: m.sender,
    agentName: m.agent_name,
    text: m.text,
    contentType: m.content_type,
    status: m.status,
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

const filterToMode = (f: InboxFilter): "bot" | "pending" | "human" | undefined =>
  f === "all" ? undefined : f;

export interface InboxListPayload {
  conversations: InboxConversationView[];
  pendingCount: number;
  asOf: string;
}

/** Load a client's inbox list (serialized), plus the pending count (tab badge). */
export async function loadInboxList(
  tenantId: string,
  clientId: string,
  filter: InboxFilter,
): Promise<InboxListPayload> {
  const mode = filterToMode(filter);
  const [rows, pendingCount] = await Promise.all([
    listConversationsForClient(tenantId, clientId, mode ? { mode } : {}),
    countPendingForClient(tenantId, clientId),
  ]);
  return {
    conversations: rows.map(toConversationView),
    pendingCount,
    asOf: new Date().toISOString(),
  };
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
  const conversation = await getConversationForClient(tenantId, clientId, conversationId);
  if (!conversation) return null;
  const messages = await listThreadMessages(tenantId, conversationId);
  return {
    header: toHeaderView(conversation),
    messages: messages.map(toMessageView),
    asOf: new Date().toISOString(),
  };
}
