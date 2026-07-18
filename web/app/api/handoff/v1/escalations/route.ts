import { z } from "zod";
import {
  authenticateHandoffRequest,
  formatConversation,
  handoffError,
  resolveWorkflowOr404,
} from "@/lib/handoffApi";
import {
  getOrCreateConversation,
  IllegalModeTransitionError,
  transitionMode,
} from "@worker/db/repositories/handoff.js";

/**
 * POST /api/handoff/v1/escalations — the workflow REQUESTS human handoff for a
 * conversation. This is a request, not a command:
 *   - mode 'bot'     → transition bot → pending (source 'workflow') → 201 (audited).
 *   - mode 'pending' → already requested → 200 current state, no transition/audit.
 *   - mode 'human'   → an agent is already on it → 200 current state, no transition.
 *
 * We NEVER call transitionMode from 'human' (bot←human is the only legal edge and it
 * is agent-only), so 'human' is handled at the endpoint without an illegal edge.
 *
 * MACHINE endpoint: Bearer token only; workflow_ref scoped to the token's connection.
 */

const Body = z.object({
  workflow_ref: z.string().min(1),
  conversation_ref: z.string().min(1).max(256),
  reason_code: z.string().optional(),
  detail: z.string().optional(),
});

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

  const wf = await resolveWorkflowOr404(auth.auth, b.workflow_ref);
  if (!wf.ok) return wf.response;

  const conv = await getOrCreateConversation(auth.auth.tenantId, b.workflow_ref, b.conversation_ref);

  // Only 'bot' → 'pending' is a real change. transitionMode is idempotent, so if two
  // escalations race, the loser sees changed:false and we return 200 (already pending).
  if (conv.mode === "bot") {
    try {
      const result = await transitionMode(auth.auth.tenantId, conv.id, "pending", {
        source: "workflow",
        reasonCode: b.reason_code ?? null,
        detail: b.detail ?? null,
      });
      return Response.json(
        { conversation: await formatConversation(result.conversation) },
        { status: result.changed ? 201 : 200 },
      );
    } catch (err) {
      // TOCTOU: an agent took (or otherwise changed) the conversation between our
      // mode read above and transitionMode's row lock, so bot→pending is no longer a
      // legal edge. That's not an error — the escalation is moot. Re-read and return
      // the current state with 200 (same semantics as the already-satisfied path).
      if (err instanceof IllegalModeTransitionError) {
        const current = await getOrCreateConversation(
          auth.auth.tenantId,
          b.workflow_ref,
          b.conversation_ref,
        );
        return Response.json({ conversation: await formatConversation(current) }, { status: 200 });
      }
      throw err;
    }
  }

  // Already 'pending' or 'human' → the request is satisfied/moot. Return the current
  // state with no transition and no audit row.
  return Response.json({ conversation: await formatConversation(conv) }, { status: 200 });
}
