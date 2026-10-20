import { buildValueDashboard, periodInputFrom } from "@/lib/valueDashboard";

/**
 * GET /api/analytics/{clientId}/value?periodo=7|30|custom&desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 *
 * The value dashboard for one period — what the page fetches when the period changes.
 * Access is the page's rule (lib/valueDashboard.ts: agency or this client's owner; 401
 * without a session, 404 otherwise), resolved from the SESSION; the payload is aggregates
 * only. Never cached: it is per user and per tenant, and a shared cache could leak it.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ clientId: string }> }): Promise<Response> {
  const { clientId } = await params;
  const sp = new URL(req.url).searchParams;
  const result = await buildValueDashboard(clientId, periodInputFrom({ periodo: sp.get("periodo"), desde: sp.get("desde"), hasta: sp.get("hasta") }));
  const headers = { "Cache-Control": "private, no-store" };
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers });
  return Response.json(result.data, { headers });
}
