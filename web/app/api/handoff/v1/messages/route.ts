import { z } from "zod";
import {
  authenticateHandoffRequest,
  formatConversation,
  handoffError,
  resolveWorkflowOr404,
} from "@/lib/handoffApi";
import { getOrCreateConversation, insertMessage } from "@worker/db/repositories/handoff.js";

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
  const auth = await authenticateHandoffRequest(req);
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

  return Response.json(
    { message_id: message.id, conversation: await formatConversation(conv) },
    { status: deduped ? 200 : 201 },
  );
}
