import { z } from "zod";
import { authenticateHandoffRequest, handoffError, resolveWorkflowOr404 } from "@/lib/handoffApi";
import { getMode } from "@worker/db/repositories/handoff.js";

/**
 * GET /api/handoff/v1/mode?workflow_ref=&conversation_ref= — the current handoff
 * mode for a conversation, so the workflow knows whether the bot should still reply.
 *
 * MACHINE endpoint: Bearer token only. workflow_ref is scoped to the token's
 * connection (else 404). An unknown conversation was never escalated → 'bot'.
 */

// This handler reads request headers + query + DB, so it is always request-time;
// force-dynamic makes that explicit and immune to static-optimization surprises.
export const dynamic = "force-dynamic";

const Query = z.object({
  workflow_ref: z.string().min(1),
  conversation_ref: z.string().min(1).max(256),
});

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateHandoffRequest(req);
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const parsed = Query.safeParse({
    workflow_ref: url.searchParams.get("workflow_ref") ?? "",
    conversation_ref: url.searchParams.get("conversation_ref") ?? "",
  });
  if (!parsed.success) {
    return handoffError(422, "invalid_query", parsed.error.issues[0]?.message ?? "Invalid query parameters.");
  }

  const wf = await resolveWorkflowOr404(auth.auth, parsed.data.workflow_ref);
  if (!wf.ok) return wf.response;

  const mode = await getMode(auth.auth.tenantId, parsed.data.workflow_ref, parsed.data.conversation_ref);
  return Response.json({ mode, as_of: new Date().toISOString() });
}
