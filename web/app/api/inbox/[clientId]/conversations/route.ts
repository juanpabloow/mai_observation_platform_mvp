import { loadInboxList, resolveInboxAccess } from "@/lib/inboxData";
import { isInboxFilter, type InboxFilter } from "@/lib/inboxView";

/**
 * GET /api/inbox/[clientId]/conversations?filter=all|pending|human|bot
 *
 * SESSION-authed inbox list for light polling (NOT the machine handoff API). Access
 * is resolved at the data layer (resolveInboxAccess): 401 unauthenticated, 404 for a
 * client the user can't see. Returns the same serialized shape the SSR page renders.
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  const { clientId } = await params;
  const access = await resolveInboxAccess(clientId);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const f = new URL(req.url).searchParams.get("filter");
  const filter: InboxFilter = isInboxFilter(f) ? f : "all";
  const payload = await loadInboxList(access.scope.tenantId, clientId, filter);
  return Response.json(payload);
}
