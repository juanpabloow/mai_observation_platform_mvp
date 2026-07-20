import { loadWorkflowInboxList, resolveWorkflowInboxAccess } from "@/lib/inboxData";

/**
 * GET /api/inbox/[clientId]/workflows/[workflowId]/conversations
 *
 * SESSION-authed per-workflow conversation list for the grid's ~5s poll. Returns ALL
 * conversations (the grid filters + counts client-side); each carries the SQL-computed
 * `active` flag and, for pending, the latest escalation reason. Access is resolved by
 * the WORKFLOW (its real client must be accessible) — the path clientId is not trusted.
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

  const payload = await loadWorkflowInboxList(access.scope.tenantId, wf);
  return Response.json(payload);
}
