import { resolveInboxAccess } from "@/lib/inboxData";
import { countPendingForClient } from "@worker/db/repositories/handoff.js";

/**
 * GET /api/inbox/[clientId]/pending-count — the tiny payload the sidebar's
 * client-level Inbox tab polls for its aggregated pending badge (Phase 4A). Access
 * via resolveInboxAccess (401 no session, 404 foreign/unknown client); the count is
 * computed in PostgreSQL scoped by tenant+client (canonical workflow→client).
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
