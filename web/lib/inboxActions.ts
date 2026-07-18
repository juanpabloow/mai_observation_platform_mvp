"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope, canAccessClient, hasFullAccess } from "./access";
import { toHeaderView } from "./inboxData";
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

const FORBIDDEN = "You don't have access to this conversation.";
const NOT_FOUND = "This conversation no longer exists.";

/** Take a bot/pending conversation into human handling (assign to the current user). */
export async function takeConversationAction(
  clientId: string,
  conversationId: string,
): Promise<InboxActionResult> {
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) return { ok: false, error: FORBIDDEN };

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
  if (!canAccessClient(scope, clientId)) return { ok: false, error: FORBIDDEN };

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, error: NOT_FOUND };
  if (conv.mode !== "pending") {
    return {
      ok: false,
      conflict: true,
      error: "This conversation is no longer pending.",
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
      error: "This conversation is no longer pending.",
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
  if (!canAccessClient(scope, clientId)) return { ok: false, error: FORBIDDEN };

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, error: NOT_FOUND };
  if (conv.mode !== "human") {
    return {
      ok: false,
      conflict: true,
      error: "This conversation isn't currently with an agent.",
      header: toHeaderView(conv),
    };
  }

  const isAssigned = conv.assigned_agent_user_id === scope.userId;
  if (!isAssigned && !hasFullAccess(scope)) {
    return {
      ok: false,
      error: "Only the assigned agent or an admin can return this conversation to the bot.",
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
      error: "This conversation changed before it could be returned.",
      header: fresh ? toHeaderView(fresh) : undefined,
    };
  }
  revalidateInbox(clientId, conversationId);
  return { ok: true, header: fresh ? toHeaderView(fresh) : undefined };
}

function takenMessage(name: string | null): string {
  return name ? `Already taken by ${name}.` : "Already taken by another agent.";
}

function revalidateInbox(clientId: string, conversationId: string): void {
  revalidatePath(`/clients/${clientId}/inbox`);
  revalidatePath(`/clients/${clientId}/inbox/${conversationId}`);
}
