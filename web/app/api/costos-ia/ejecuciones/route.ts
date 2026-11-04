import { periodInputFrom } from "@/lib/valueDashboard";
import { buildExecutions } from "@/lib/n8nExecutions";
import { baselineInputFrom } from "@worker/analytics/aiCostPeriods.js";

/**
 * GET /api/costos-ia/ejecuciones?periodo=…&comparar=…[&cliente=<id>]
 *
 * COSTOS DE IA → Ejecuciones for one period plus the comparison one — what the screen fetches
 * when the period changes. Same access as /api/costos-ia (lib/n8nExecutions.ts): 401 without a
 * session, 404 otherwise. Counts only, no execution content. Never cached.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const result = await buildExecutions(
    periodInputFrom({ periodo: sp.get("periodo"), desde: sp.get("desde"), hasta: sp.get("hasta") }),
    baselineInputFrom({ comparar: sp.get("comparar"), cdesde: sp.get("cdesde"), chasta: sp.get("chasta") }),
    { clientId: sp.get("cliente") },
  );
  const headers = { "Cache-Control": "private, no-store" };
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status, headers });
  return Response.json(result.data, { headers });
}
