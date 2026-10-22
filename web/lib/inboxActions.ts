"use server";

import { revalidatePath } from "next/cache";
import { NO_PERMISSION, can, getAccessScope, type AccessScope } from "./access";
import { checkInboxAccess, toHeaderView } from "./inboxData";
import type { InboxHeaderView } from "./inboxView";
import { getConversationForClient, transitionMode } from "@worker/db/repositories/handoff.js";

/**
 * Inbox agent actions (H-2): take / dismiss / return-to-bot. EVERY action:
 *   1. Resolves the session scope and checks client access at the DATA LAYER
 *      (canAccessClient) — never trusting the clientId in the request.
 *   2. Resolves the conversation ONLY within that client (getConversationForClient);
 *      a foreign/other-client conversation is indistinguishable from not-found.
 *   3. Drives the change through transitionMode (source 'agent', the acting user),
 *      using expectedFrom so a concurrent change can't be clobbered.
 *
 * Results carry a fresh header so the client can update immediately; conflict=true
 * means a concurrent change mooted the action (e.g. someone else took it first).
 */

export interface InboxActionResult {
  ok: boolean;
  error?: string;
  /** The action was mooted by a concurrent change; header reflects the real state. */
  conflict?: boolean;
  /** Fresh conversation header for immediate UI reconciliation. */
  header?: InboxHeaderView;
}

const FORBIDDEN = "No tienes acceso a esta conversación.";
const NOT_FOUND = "Esta conversación ya no existe.";
const INBOX_DISABLED = "El inbox está desactivado para este cliente.";

/** Server-side INBOX module gate for the human-intervention actions. Hiding the UI
 * is never enough — take/dismiss/return are refused when inbox is off for the client
 * (any role). Active human/pending conversations block a disable, so these actions
 * can't race a disable into an active-but-disabled state (the escalation path, which
 * CAN, is separately race-safe via transitionMode's inboxGate). */
/** The inbox gate for an agent action (inbox.reply), as the message to return — or null. */
async function inboxDenied(scope: AccessScope, clientId: string): Promise<string | null> {
  const r = await checkInboxAccess(scope, clientId, "inbox.reply");
  if (r === "ok") return null;
  return r === "disabled" ? INBOX_DISABLED : r === "forbidden" ? NO_PERMISSION : FORBIDDEN;
}

/** Take a bot/pending conversation into human handling (assign to the current user). */
export async function takeConversationAction(
  clientId: string,
  conversationId: string,
): Promise<InboxActionResult> {
  const scope = await getAccessScope();
  const denied = await inboxDenied(scope, clientId);
  if (denied) return { ok: false, error: denied };

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, error: NOT_FOUND };
  if (conv.mode === "human") {
    return {
      ok: false,
      conflict: true,
      error: takenMessage(conv.assigned_agent_name),
      header: toHeaderView(conv),
    };
  }

  // bot→human and pending→human are both legal agent edges. If it became human
  // between our read and the lock, transitionMode returns changed:false (no-op).
  const res = await transitionMode(scope.tenantId, conversationId, "human", {
    source: "agent",
    agentUserId: scope.userId,
  });
  const fresh = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!res.changed) {
    return {
      ok: false,
      conflict: true,
      error: takenMessage(fresh?.assigned_agent_name ?? null),
      header: fresh ? toHeaderView(fresh) : undefined,
    };
  }
  revalidateInbox(clientId, conversationId);
  return { ok: true, header: fresh ? toHeaderView(fresh) : undefined };
}

/** Dismiss a pending conversation back to the bot (without taking it). */
export async function dismissConversationAction(
  clientId: string,
  conversationId: string,
): Promise<InboxActionResult> {
  const scope = await getAccessScope();
  const denied = await inboxDenied(scope, clientId);
  if (denied) return { ok: false, error: denied };

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, error: NOT_FOUND };
  if (conv.mode !== "pending") {
    return {
      ok: false,
      conflict: true,
      error: "Esta conversación ya no está esperando a una persona.",
      header: toHeaderView(conv),
    };
  }

  // expectedFrom 'pending' → if a concurrent take made it human, this is a no-op
  // (human→bot is otherwise legal, which would wrongly un-take it).
  const res = await transitionMode(scope.tenantId, conversationId, "bot", {
    source: "agent",
    agentUserId: scope.userId,
    expectedFrom: "pending",
  });
  const fresh = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!res.changed) {
    return {
      ok: false,
      conflict: true,
      error: "Esta conversación ya no está esperando a una persona.",
      header: fresh ? toHeaderView(fresh) : undefined,
    };
  }
  revalidateInbox(clientId, conversationId);
  return { ok: true, header: fresh ? toHeaderView(fresh) : undefined };
}

/**
 * Return a human conversation to the bot. Allowed ONLY for the assigned agent OR a
 * full-access user (owner/admin) — enforced server-side, not just hidden in the UI.
 */
export async function returnConversationToBotAction(
  clientId: string,
  conversationId: string,
): Promise<InboxActionResult> {
  const scope = await getAccessScope();
  const denied = await inboxDenied(scope, clientId);
  if (denied) return { ok: false, error: denied };

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, error: NOT_FOUND };
  if (conv.mode !== "human") {
    return {
      ok: false,
      conflict: true,
      error: "Esta conversación no la está atendiendo una persona.",
      header: toHeaderView(conv),
    };
  }

  const isAssigned = conv.assigned_agent_user_id === scope.userId;
  if (!isAssigned && !can(scope, "inbox.supervise", clientId)) {
    return {
      ok: false,
      error: "Solo la persona asignada o un administrador puede devolverla al bot.",
    };
  }

  const res = await transitionMode(scope.tenantId, conversationId, "bot", {
    source: "agent",
    agentUserId: scope.userId,
    expectedFrom: "human",
  });
  const fresh = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!res.changed) {
    return {
      ok: false,
      conflict: true,
      error: "La conversación cambió antes de poder devolverla. Revisa su estado.",
      header: fresh ? toHeaderView(fresh) : undefined,
    };
  }
  revalidateInbox(clientId, conversationId);
  return { ok: true, header: fresh ? toHeaderView(fresh) : undefined };
}

function takenMessage(name: string | null): string {
  return name ? `${name.trim().split(/\s+/)[0]} ya la tomó.` : "Otra persona ya la tomó.";
}

function revalidateInbox(clientId: string, conversationId: string): void {
  revalidatePath(`/clients/${clientId}/inbox`);
  revalidatePath(`/clients/${clientId}/inbox/${conversationId}`);
}
