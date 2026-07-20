import { loadWorkflowInboxList, resolveWorkflowInboxAccess } from "@/lib/inboxData";
import { isInboxFilter, type InboxFilter } from "@/lib/inboxView";

/**
 * GET /api/inbox/[clientId]/workflows/[workflowId]/conversations?filter=all|pending|human|bot
 *
 * SESSION-authed per-workflow inbox list for light polling. Access is resolved by the
 * WORKFLOW (its real client must be accessible to the user) — the path clientId is not
 * trusted. 401 unauthenticated, 404 for a foreign/inaccessible workflow.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ clientId: string; workflowId: string }> },
): Promise<Response> {
  const { workflowId } = await params;
  const access = await resolveWorkflowInboxAccess(decodeURIComponent(workflowId));
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const f = new URL(req.url).searchParams.get("filter");
  const filter: InboxFilter = isInboxFilter(f) ? f : "all";
  const payload = await loadWorkflowInboxList(access.scope.tenantId, decodeURIComponent(workflowId), filter);
  return Response.json(payload);
}
