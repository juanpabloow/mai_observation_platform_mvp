import { loadScopedClientInbox, resolveInboxAccess } from "@/lib/inboxData";
import { validateWorkflowForClient } from "@/lib/workflowScope";

/**
 * GET /api/inbox/[clientId]/conversations[?workflow=<n8nWorkflowId>]
 *
 * SESSION-authed client inbox list for the workspace's ~5s poll. Access is resolved at
 * the data layer (resolveInboxAccess): 401 without a session, 404 for a foreign/unknown
 * client, one outside a member's scope, or a client whose `inbox` module is off.
 *
 * The optional ?workflow= applies the W-1 workflow SCOPE at the DATA LAYER: a workflow
 * that exists, belongs to THIS client, and is accessible ⇒ only that workflow's
 * conversations; anything invalid/foreign/absent ⇒ the whole client ('all'). tenant_id
 * is NEVER taken from the request; the SQL filters by tenant+client so no leak.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  const { clientId } = await params;
  const access = await resolveInboxAccess(clientId);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const wf = new URL(req.url).searchParams.get("workflow");
  let scope: "all" | string = "all";
  if (wf && wf !== "all") {
    scope = (await validateWorkflowForClient(access.scope.tenantId, clientId, wf, access.scope))
      ? wf
      : "all";
  }

  const payload = await loadScopedClientInbox(access.scope.tenantId, clientId, scope);
  return Response.json(payload);
}
