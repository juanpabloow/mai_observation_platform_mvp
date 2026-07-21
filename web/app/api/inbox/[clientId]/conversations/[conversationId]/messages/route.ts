import { loadInboxThread, resolveInboxAccess } from "@/lib/inboxData";

/**
 * GET /api/inbox/[clientId]/conversations/[conversationId]/messages
 *
 * SESSION-authed thread poll (header + messages). Access at the data layer; the
 * conversation must belong to this client (loadInboxThread returns null otherwise →
 * 404, so probing another client's conversation is indistinguishable from missing).
 */
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ clientId: string; conversationId: string }> },
): Promise<Response> {
  const { clientId, conversationId } = await params;
  const access = await resolveInboxAccess(clientId);
  if (!access.ok) return Response.json({ error: "forbidden" }, { status: access.status });

  // The drawer's initial open requests ?history=1 (pre-handoff derived turns); the
  // ~4s poll omits it to avoid the extra query.
  const includeHistory = new URL(req.url).searchParams.get("history") === "1";
  const payload = await loadInboxThread(
    access.scope.tenantId,
    clientId,
    decodeURIComponent(conversationId),
    { includeHistory },
  );
  if (!payload) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(payload);
}
