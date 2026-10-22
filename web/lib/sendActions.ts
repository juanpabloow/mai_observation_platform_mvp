"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope, NO_PERMISSION } from "./access";
import { checkInboxAccess } from "./inboxData";
import { toHeaderView } from "./inboxData";
import { sendToWebhook } from "./sendToWebhook";
import type { InboxMessageView, SendActionResult } from "./inboxView";
import {
  getAgentSummary,
  getConversationForClient,
  claimFailedMessageForRetry,
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
  const access = await checkInboxAccess(scope, clientId, "inbox.reply");
  if (access === "not_found") {
    return { ok: false, code: "forbidden", error: "No tienes acceso a esta conversación." };
  }
  if (access === "disabled") {
    return { ok: false, code: "disabled", error: "El inbox está desactivado para este cliente." };
  }
  if (access === "forbidden") return { ok: false, code: "forbidden", error: NO_PERMISSION };
  if (typeof text !== "string" || text.trim().length === 0) {
    return { ok: false, code: "invalid", error: "El mensaje no puede estar vacío." };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_BYTES) {
    return { ok: false, code: "invalid", error: "El mensaje es demasiado largo (máximo 64 KB)." };
  }

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, code: "not_found", error: "Esta conversación ya no existe." };
  if (conv.mode !== "human") {
    return {
      ok: false,
      code: "mode_changed",
      error: "La conversación volvió al bot: tómala de nuevo para escribir.",
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
  const access = await checkInboxAccess(scope, clientId, "inbox.reply");
  if (access === "not_found") {
    return { ok: false, code: "forbidden", error: "No tienes acceso a esta conversación." };
  }
  if (access === "disabled") {
    return { ok: false, code: "disabled", error: "El inbox está desactivado para este cliente." };
  }
  if (access === "forbidden") return { ok: false, code: "forbidden", error: NO_PERMISSION };

  const conv = await getConversationForClient(scope.tenantId, clientId, conversationId);
  if (!conv) return { ok: false, code: "not_found", error: "Esta conversación ya no existe." };
  if (conv.mode !== "human") {
    return {
      ok: false,
      code: "mode_changed",
      error: "La conversación volvió al bot: tómala de nuevo para escribir.",
      header: toHeaderView(conv),
    };
  }

  // The webhook first: claiming before it would strand the row in 'sending' when sending
  // is disabled.
  const guard = await resolveEnabledWebhook(scope.tenantId, conv.n8n_workflow_id);
  if (!guard.ok) return guard.result;

  // ATOMIC claim: only a still-FAILED human-agent message moves back to 'sending' (prior
  // failure cleared, SAME id = same idempotency key). An already-sent message, or a second
  // concurrent click, claims nothing — so a retry can never re-POST a delivered message
  // or POST the same one twice.
  const msg = await claimFailedMessageForRetry(scope.tenantId, conversationId, messageId);
  if (!msg) {
    return { ok: false, code: "not_found", error: "Ese mensaje no se puede reintentar." };
  }
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
      result: { ok: false, code: "no_webhook", error: "Este flujo no tiene configurado el envío de mensajes." },
    };
  }
  if (!webhook.enabled) {
    return {
      ok: false,
      result: { ok: false, code: "disabled", error: "El envío está desactivado para este flujo." },
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
    failureDetail = outcome.detail ?? "El canal rechazó el mensaje.";
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
    // A human reply sent from the composer is plain text; structured payloads are
    // written by the agent side, never here.
    payload: null,
  };
}

function revalidateThread(clientId: string, conversationId: string): void {
  revalidatePath(`/clients/${clientId}/inbox/${conversationId}`);
  revalidatePath(`/clients/${clientId}/inbox`);
}
