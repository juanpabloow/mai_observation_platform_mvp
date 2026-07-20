import { resolveWorkflowInboxAccess } from "@/lib/inboxData";
import { countPendingForWorkflow } from "@worker/db/repositories/handoff.js";

/**
 * GET /api/inbox/[clientId]/workflows/[workflowId]/pending-count — the tiny payload the
 * sidebar Inbox tab polls so its per-workflow pending badge stays live (H-7 replaced
 * the client-level attention badge with this). Access resolved by the workflow.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clientId: string; workflowId: string }> },
): Promise<Response> {
  const { workflowId } = await params;
  const wf = decodeURIComponent(workflowId);
  const access = await resolveWorkflowInboxAccess(wf);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const pendingCount = await countPendingForWorkflow(access.scope.tenantId, wf);
  return Response.json({ pendingCount, asOf: new Date().toISOString() });
}
