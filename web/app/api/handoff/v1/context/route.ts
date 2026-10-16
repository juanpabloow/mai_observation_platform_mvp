import { z } from "zod";
import { authenticateHandoffRequest, handoffError, moduleDisabled, resolveWorkflowOr404 } from "@/lib/handoffApi";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { readConversationContext } from "@worker/db/repositories/handoffContext.js";
import { isSentinelIdentifier, isQuarantinedRef } from "@worker/identity/sentinel.js";

export const dynamic = "force-dynamic";

const Query = z.object({
  workflow_ref: z.string().min(1).max(256),
  conversation_ref: z.string().min(1).max(256),
  through_message_id: z.uuid(),
}).strict();

function noStore(response: Response): Response {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Authorization");
  return response;
}

/** Opt-in machine read. Session cookies alone never authorize history access. */
export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateHandoffRequest(req, "handoff.context.read");
  if (!auth.ok) return noStore(auth.response);
  const params = new URL(req.url).searchParams;
  const parsed = Query.safeParse(Object.fromEntries(params));
  if (!parsed.success || [...params.keys()].some((key) => params.getAll(key).length !== 1)) {
    return noStore(handoffError(422, "invalid_query", "Provide workflow_ref, conversation_ref and through_message_id only."));
  }
  // ID-H §1: a sentinel ref is refused outright (422); a quarantined conversation is never
  // readable — treat it as the endpoint's standard "not found", even with a valid anchor.
  if (isSentinelIdentifier(parsed.data.conversation_ref)) {
    return noStore(handoffError(422, "invalid_conversation_ref", "conversation_ref is empty or a placeholder, not a real identifier."));
  }
  if (isQuarantinedRef(parsed.data.conversation_ref)) {
    return noStore(handoffError(404, "not_found", "Conversation context not found."));
  }
  const wf = await resolveWorkflowOr404(auth.auth, parsed.data.workflow_ref);
  if (!wf.ok) return noStore(wf.response);
  if (wf.clientIsDefault || !await isClientModuleEnabled(auth.auth.tenantId, wf.clientId, "inbox")) {
    return noStore(moduleDisabled("inbox"));
  }
  const context = await readConversationContext({
    tenantId: auth.auth.tenantId, connectionId: auth.auth.connectionId,
    clientId: wf.clientId, workflowRef: parsed.data.workflow_ref,
    conversationRef: parsed.data.conversation_ref, throughMessageId: parsed.data.through_message_id,
  });
  if (!context) return noStore(handoffError(404, "not_found", "Conversation context not found."));
  return noStore(Response.json(context));
}
