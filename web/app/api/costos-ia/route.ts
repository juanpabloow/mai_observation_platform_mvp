import { periodInputFrom } from "@/lib/valueDashboard";
import { buildAiCosts } from "@/lib/aiCosts";
import { baselineInputFrom } from "@worker/analytics/aiCostPeriods.js";

/**
 * GET /api/costos-ia?periodo=7|30|custom&desde&hasta&comparar=anterior|mes|custom&cdesde&chasta[&cliente=<id>]
 *
 * COSTOS DE IA for one period plus the previous one — what the page fetches when the period
 * changes. From the SESSION (401 without one, 404 otherwise): the agency, or with `cliente`
 * whoever may see that business's value dashboard (lib/aiCosts.ts). Aggregates only.
 * Never cached: per user and per tenant.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const result = await buildAiCosts(
    periodInputFrom({ periodo: sp.get("periodo"), desde: sp.get("desde"), hasta: sp.get("hasta") }),
    baselineInputFrom({ comparar: sp.get("comparar"), cdesde: sp.get("cdesde"), chasta: sp.get("chasta") }),
    { clientId: sp.get("cliente") },
  );
  const headers = { "Cache-Control": "private, no-store" };
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers });
  return Response.json(result.data, { headers });
}
