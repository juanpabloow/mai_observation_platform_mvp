import { z } from "zod";
import {
  authenticateHandoffRequest,
  formatConversation,
  handoffError,
  resolveWorkflowOr404,
} from "@/lib/handoffApi";
import { getOrCreateConversation, insertMessage } from "@worker/db/repositories/handoff.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { ensureContactForInboundMessage } from "@worker/db/repositories/contactIdentities.js";
import { identitiesSchema } from "@/lib/identities";
import { logger } from "@worker/logger.js";

/**
 * POST /api/handoff/v1/messages — record an inbound conversation message.
 *
 * MACHINE endpoint: Bearer token only (no session/cookie). The token authorizes
 * ONLY workflows under its own connection; any other workflow_ref → 404. sender is
 * 'user' | 'bot' — a 'human_agent' message never arrives this way (→ 422). Dedup by
 * (conversation, external_message_id): a repeat returns 200 with the SAME message_id,
 * a fresh insert returns 201.
 */

// 64 KiB text ceiling (chars ≈ bytes for the ASCII/UTF-8 body we expect; a generous
// bound that still rejects obviously abusive payloads).
const MAX_TEXT = 64 * 1024;

const Body = z
  .object({
    workflow_ref: z.string().min(1),
    conversation_ref: z.string().min(1).max(256),
    // 'human_agent' is intentionally NOT accepted here — inbound machine traffic is
    // only ever the end user or the bot. Agent messages come from the platform.
    sender: z.enum(["user", "bot"]),
    text: z.string().max(MAX_TEXT).optional(),
    content_type: z.string().min(1).optional().default("text"),
    content_detail: z.string().optional(),
    external_message_id: z.string().min(1).optional(),
    occurred_at: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    // D-2 (additive to handoff contract v1): a free-text SOURCE hint for an auto-created
    // contact ("whatsapp", "instagram", "webchat"). Stored as the identity label + the
    // contact's channel; DISPLAYED, never branched on. Absent → a neutral "conversation".
    identity_label: z.string().min(1).max(64).optional(),
    // I-1 (additive to handoff contract v1): every identity the workflow knows for this
    // person — [{kind, value, label}]. conversation_ref is UNCHANGED (still identifies the
    // CONVERSATION); these ADD to the resolved contact. Absent → exactly today's behavior.
    identities: identitiesSchema,
  })
  .refine(
    (d) => {
      // text is required when the content is textual (the default).
      const ct = d.content_type ?? "text";
      return ct !== "text" || (typeof d.text === "string" && d.text.length > 0);
    },
    { message: "text is required when content_type is 'text'", path: ["text"] },
  );

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateHandoffRequest(req, "handoff");
  if (!auth.ok) return auth.response;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return handoffError(422, "invalid_body", "Request body must be valid JSON.");
  }

  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return handoffError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  }
  const b = parsed.data;

  // occurred_at: optional ISO-8601 → Date (default now). Invalid → 422. (We validate
  // manually rather than with zod's .datetime(), which is stricter than we want.)
  let occurredAt = new Date();
  if (b.occurred_at !== undefined) {
    const d = new Date(b.occurred_at);
    if (Number.isNaN(d.getTime())) {
      return handoffError(422, "invalid_body", "occurred_at must be an ISO-8601 datetime.");
    }
    occurredAt = d;
  }

  const wf = await resolveWorkflowOr404(auth.auth, b.workflow_ref);
  if (!wf.ok) return wf.response;

  const conv = await getOrCreateConversation(auth.auth.tenantId, b.workflow_ref, b.conversation_ref);
  const { message, deduped } = await insertMessage({
    tenantId: auth.auth.tenantId,
    conversationId: conv.id,
    sender: b.sender,
    text: b.text ?? null,
    contentType: b.content_type,
    contentDetail: b.content_detail ?? null,
    externalMessageId: b.external_message_id ?? null,
    status: "received",
    occurredAt,
    metadata: b.metadata ?? null,
  });

  // D-2: a real person who writes must exist in the CRM. Only for an inbound USER message, and
  // only when CRM is ON for the client. FAIL-SAFE: any failure here must NOT fail the push —
  // the message reaching the inbox matters more, and the workflow's gate depends on this
  // response. Runs when the conversation is still unlinked (first message) OR — I-1 — whenever
  // the push DECLARES identities, so a workflow can enrich an already-linked contact with a
  // newly-learned identifier on any later message. A plain later message (linked, no
  // identities) still skips it, so there's no cost on the hot path.
  const hasIdentities = !!b.identities && b.identities.length > 0;
  if (b.sender === "user" && (conv.contact_id === null || hasIdentities)) {
    try {
      if (await isClientModuleEnabled(auth.auth.tenantId, wf.clientId, "crm")) {
        await ensureContactForInboundMessage(auth.auth.tenantId, wf.clientId, conv.id, b.conversation_ref, b.identity_label ?? "conversation", b.identities);
      }
    } catch (err) {
      logger.warn({ err: String(err), conversationId: conv.id, clientId: wf.clientId }, "D-2/I-1: contact resolve/enrich failed; message push unaffected");
    }
  }

  return Response.json(
    { message_id: message.id, conversation: await formatConversation(conv) },
    { status: deduped ? 200 : 201 },
  );
}
