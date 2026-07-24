import { loadClientInboxList, resolveInboxAccess } from "@/lib/inboxData";

/**
 * GET /api/inbox/[clientId]/conversations
 *
 * SESSION-authed UNIFIED client inbox list for the grid's ~5s poll — the
 * live/handoff conversations of ALL the client's canonical workflows in one tray.
 * Access is resolved at the data layer (resolveInboxAccess): 401 without a session,
 * 404 for a foreign/unknown client or one outside a member's scope. tenant_id is
 * NEVER taken from the request; the SQL filters by tenant+client (canonical
 * workflow→client), so another client's conversations can't leak in.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  const { clientId } = await params;
  const access = await resolveInboxAccess(clientId);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const payload = await loadClientInboxList(access.scope.tenantId, clientId);
  return Response.json(payload);
}
