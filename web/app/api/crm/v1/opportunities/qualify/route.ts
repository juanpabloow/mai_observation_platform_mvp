import { z } from "zod";
import { authenticateCrm, crmError } from "@/lib/crmApi";
import { identitiesSchema } from "@/lib/identities";
import { isSentinelIdentifier, isQuarantinedRef } from "@worker/identity/sentinel.js";
import { getOrCreateConversation, findConversationMessageIdByExternalId } from "@worker/db/repositories/handoff.js";
import { ensureContactForInboundMessage } from "@worker/db/repositories/contactIdentities.js";
import { qualifyFromBot } from "@worker/pipeline/engine.js";
import { logger } from "@worker/logger.js";

/**
 * POST /api/crm/v1/opportunities/qualify   [pipeline.write]
 *
 * THE BOT QUALIFIES. The n8n agent marks the CURRENT conversation's sale as qualified, with the
 * evidence it gathered — WHAT service the customer wants and WHEN (a day or a near range like
 * "hoy" / "mañana" / "el sábado" / "esta semana"; vague timing does not qualify). The decision is
 * the bot's; this records it through the SAME PL-1 engine the Setter's UI uses (actor = bot), so a
 * person can still correct it in the pipeline board.
 *
 * Identity is channel-blind and id-free, exactly like the other machine endpoints: the token
 * (Bearer) + X-Workflow-Ref fix the tenant + client; `conversation_ref` (+ optional `identities`)
 * resolves the conversation and its contact (the sender). The caller NEVER sends a tenant, client,
 * contact or opportunity id. Naturally idempotent: a repeat writes no event and never overwrites
 * earlier evidence. Fail-safe — it only ever touches opportunities, never messages or bookings.
 */
export const dynamic = "force-dynamic";

const Body = z
  .object({
    conversation_ref: z.string().trim().min(1).max(256),
    service: z.string().trim().min(1).max(120),
    timeframe: z.string().trim().min(1).max(120),
    // The inbound message (external/channel id) that carried the evidence. Stored only when it
    // resolves to a message of THIS conversation; otherwise ignored (never an error).
    message_ref: z.string().trim().min(1).max(256).optional(),
    identities: identitiesSchema,
  })
  .strict();

export async function POST(req: Request): Promise<Response> {
  // Bearer + SHA-256 token, the `pipeline.write` capability gate, X-Workflow-Ref → client
  // resolution (foreign ref → 404), and the CRM module gate (off / default client → 403) — all
  // here. A token without `pipeline.write` is refused with the same 401 as a bad token.
  const auth = await authenticateCrm(req, "pipeline.write");
  if (!auth.ok) return auth.response;
  const { tenantId, clientId, workflowRef } = auth.auth;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return crmError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return crmError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  const b = parsed.data;

  // ID-H §1: refuse placeholder/unrendered values BEFORE any write. A garbage conversation_ref
  // would collapse strangers into one thread; garbage evidence is not evidence.
  if (isSentinelIdentifier(b.conversation_ref) || isQuarantinedRef(b.conversation_ref)) {
    return crmError(422, "invalid_conversation_ref", "conversation_ref is empty or a placeholder (e.g. \"undefined\"). Send the customer's wa_id, or their user_id when there is no phone.");
  }
  if (isSentinelIdentifier(b.service) || isSentinelIdentifier(b.timeframe)) {
    return crmError(422, "invalid_body", "service and timeframe must be the real evidence (what + when), not a placeholder.");
  }
  for (const it of b.identities ?? []) {
    if (isSentinelIdentifier(it.value)) return crmError(422, "invalid_identity", "identities: a value is empty or a placeholder, not a real identifier.");
  }

  try {
    // Resolve the conversation + its contact (the sender) exactly as an inbound message does.
    const conv = await getOrCreateConversation(tenantId, workflowRef, b.conversation_ref);
    let contactId = conv.contact_id;
    if (contactId === null || (b.identities && b.identities.length > 0)) {
      const resolved = await ensureContactForInboundMessage(tenantId, clientId, conv.id, b.conversation_ref, "conversation", b.identities);
      contactId = resolved.contactId;
    }
    if (!contactId) return crmError(404, "contact_not_found", "No contact resolves for that conversation_ref under this client.");

    // Keep the evidence message only when it truly belongs to this conversation (else ignore it).
    const messageId = b.message_ref ? await findConversationMessageIdByExternalId(tenantId, conv.id, b.message_ref) : null;

    const { opportunity, changed } = await qualifyFromBot(
      tenantId,
      clientId,
      contactId,
      conv.id,
      { service: b.service, timeframe: b.timeframe, messageId },
      { kind: "bot" },
    );
    // Minimal, id-free: the state the bot can read back + whether this call moved it.
    return Response.json({ stage: opportunity.stage, status: opportunity.status, changed });
  } catch (err) {
    // Fail-safe: never a bare 500. This endpoint touches only opportunities, so a failure here
    // cannot affect message writes or bookings — it just reports the sale couldn't be recorded.
    logger.warn({ err: String(err), clientId }, "PL-3: qualifyFromBot failed");
    return crmError(503, "pipeline_unavailable", "Could not record the qualification right now. The conversation is unaffected; retry.");
  }
}
