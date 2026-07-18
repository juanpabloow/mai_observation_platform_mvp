import { resolveInboxAccess } from "@/lib/inboxData";
import { countPendingForClient } from "@worker/db/repositories/handoff.js";

/**
 * GET /api/inbox/[clientId]/pending-count — the tiny payload the sidebar Inbox tab
 * polls so its "Inbox · N" badge stays live from any tab of the client. Session-
 * authed, data-layer access check.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clientId: string }> },
): Promise<Response> {
  const { clientId } = await params;
  const access = await resolveInboxAccess(clientId);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  const pendingCount = await countPendingForClient(access.scope.tenantId, clientId);
  return Response.json({ pendingCount, asOf: new Date().toISOString() });
}
