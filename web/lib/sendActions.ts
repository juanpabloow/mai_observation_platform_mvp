"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope, canAccessClient } from "./access";
import { toHeaderView } from "./inboxData";
import { sendToWebhook } from "./sendToWebhook";
import type { InboxMessageView, SendActionResult } from "./inboxView";
import {
  getAgentSummary,
  getConversationForClient,
  getHandoffMessage,
  insertMessage,
  updateMessageDelivery,
  type InboxConversationDetail,
} from "@worker/db/repositories/handoff.js";
import { getWebhookForWorkflow, setDeliveryResult } from "@worker/db/repositories/webhooks.js";

/**
 * The outbound SEND pipeline (composer → workflow), H-3 (contract §5 Exchange 4).
 * Order is deliberate so every failure mode leaves a coherent record:
 *   1. access + conversation.mode==='human' + text non-empty/≤64KB
 *   2. resolve the webhook (registered + enabled)
 *   3. insert the message as 'human_agent' / 'sending' (its id IS the idempotency key)
 *   4. POST (signed, 10s) and reconcile status → sent | failed
 * There are NO automatic retries — double-sending to an end user is worse than an
 * agent clicking Retry.
 */

const MAX_TEXT_BYTES = 64 * 1024;

/** Send a new agent reply. */
export async function sendMessageAction(
  clientId: string,
  conversationId: string,
  text: string,
): Promise<SendActionResult> {
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) {
    return { ok: false, code: "forbidden", error: "You don't have access to this conversation." };
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, code: "invalid", error: "Message can't be empty." };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    return { ok: false, code: "invalid", error: "Message is too long (64 KB max)." };
  }

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, code: "not_found", error: "This conversation no longer exists." };
  if (conv.mode !== "human") {
    return {
      ok: false,
      code: "mode_changed",
      error: "This conversation was returned to the bot — you can't send right now.",
      header: toHeaderView(conv),
    };
  }

  const guard = await resolveEnabledWebhook(scope.tenantId, conv.n8n_workflow_id);
  if (!guard.ok) return guard.result;

  // Insert as 'sending' — the message id becomes the idempotency key.
  const { message } = await insertMessage({
    tenantId: scope.tenantId,
    conversationId: conv.id,
    sender: "human_agent",
    agentUserId: scope.userId,
    text,
    status: "sending",
    occurredAt: new Date(),
  });

  const view = await deliverMessage(scope.tenantId, conv, guard.webhook, {
    id: message.id,
    text,
    agentUserId: scope.userId,
  });
  revalidateThread(clientId, conversationId);
  return { ok: true, message: view };
}

/** Retry a previously-failed send: SAME message row, SAME idempotency key, re-POST. */
export async function retrySendAction(
  clientId: string,
  conversationId: string,
  messageId: string,
): Promise<SendActionResult> {
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) {
    return { ok: false, code: "forbidden", error: "You don't have access to this conversation." };
  }

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, code: "not_found", error: "This conversation no longer exists." };
  if (conv.mode !== "human") {
    return {
      ok: false,
      code: "mode_changed",
      error: "This conversation was returned to the bot — you can't send right now.",
      header: toHeaderView(conv),
    };
  }

  const msg = await getHandoffMessage(scope.tenantId, conversationId, messageId);
  if (!msg || msg.sender !== "human_agent") {
    return { ok: false, code: "not_found", error: "That message can't be retried." };
  }

  const guard = await resolveEnabledWebhook(scope.tenantId, conv.n8n_workflow_id);
  if (!guard.ok) return guard.result;

  // Back to 'sending', clear the prior failure, reuse the SAME id (idempotency key).
  await updateMessageDelivery({
    tenantId: scope.tenantId,
    messageId,
    status: "sending",
    failureCode: null,
    failureDetail: null,
  });
  const view = await deliverMessage(scope.tenantId, conv, guard.webhook, {
    id: msg.id,
    text: msg.text ?? "",
    agentUserId: msg.agent_user_id ?? scope.userId,
  });
  revalidateThread(clientId, conversationId);
  return { ok: true, message: view };
}

// ── private helpers (NOT server actions — not exported) ──────────────────────

type WebhookGuard =
  | { ok: true; webhook: { url: string; secret: string } }
  | { ok: false; result: Extract<SendActionResult, { ok: false }> };

async function resolveEnabledWebhook(tenantId: string, n8nWorkflowId: string): Promise<WebhookGuard> {
  const webhook = await getWebhookForWorkflow(tenantId, n8nWorkflowId);
  if (!webhook) {
    return {
      ok: false,
      result: { ok: false, code: "no_webhook", error: "No send webhook is configured for this workflow." },
    };
  }
  if (!webhook.enabled) {
    return {
      ok: false,
      result: { ok: false, code: "disabled", error: "Sending is disabled for this workflow." },
    };
  }
  return { ok: true, webhook: { url: webhook.url, secret: webhook.secret } };
}

/**
 * POST one message and reconcile its status + the webhook health signal. Returns the
 * serialized message view (sent OR failed) for immediate optimistic reconciliation.
 */
async function deliverMessage(
  tenantId: string,
  conv: InboxConversationDetail,
  webhook: { url: string; secret: string },
  msg: { id: string; text: string; agentUserId: string },
): Promise<InboxMessageView> {
  const agent = await getAgentSummary(msg.agentUserId);
  const outcome = await sendToWebhook({
    url: webhook.url,
    secret: webhook.secret,
    body: {
      type: "handoff.send_message",
      idempotency_key: msg.id,
      workflow_ref: conv.n8n_workflow_id,
      conversation_ref: conv.conversation_ref,
      text: msg.text,
      agent: { id: msg.agentUserId, name: agent?.name ?? null },
    },
  });

  let status: "sent" | "failed";
  let externalMessageId: string | null = null;
  let failureCode: string | null = null;
  let failureDetail: string | null = null;
  let deliveryResult: "sent" | "rejected" | "failed";

  if (outcome.kind === "sent") {
    status = "sent";
    externalMessageId = outcome.externalMessageId;
    deliveryResult = "sent";
  } else if (outcome.kind === "rejected") {
    status = "failed";
    failureCode = outcome.code ?? "REJECTED";
    failureDetail = outcome.detail ?? "The channel rejected the message.";
    deliveryResult = "rejected";
  } else {
    status = "failed";
    failureCode = "DELIVERY_FAILED";
    failureDetail = outcome.detail;
    deliveryResult = "failed";
  }

  const updated = await updateMessageDelivery({
    tenantId,
    messageId: msg.id,
    status,
    externalMessageId,
    failureCode,
    failureDetail,
  });
  await setDeliveryResult(tenantId, conv.n8n_workflow_id, deliveryResult);

  return {
    id: msg.id,
    sender: "human_agent",
    agentName: agent?.name ?? null,
    text: updated?.text ?? msg.text,
    contentType: updated?.content_type ?? "text",
    status,
    failureCode,
    failureDetail,
    occurredAt: (updated?.occurred_at ?? new Date()).toISOString(),
  };
}

function revalidateThread(clientId: string, conversationId: string): void {
  revalidatePath(`/clients/${clientId}/inbox/${conversationId}`);
  revalidatePath(`/clients/${clientId}/inbox`);
}
