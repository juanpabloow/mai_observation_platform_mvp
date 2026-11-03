import { periodInputFrom } from "@/lib/valueDashboard";
import { buildAiCosts } from "@/lib/aiCosts";
import { baselineInputFrom } from "@worker/analytics/aiCostPeriods.js";
import { renderAiCostCsv, renderAiCostMarkdown, reportFileStem } from "@worker/analytics/aiCostReport.js";

/**
 * GET /api/costos-ia/informe?formato=md|csv&periodo=…&comparar=anterior|mes|custom&cdesde&chasta
 *
 * The COSTOS DE IA report as a download: Markdown (people + an AI: definitions, caveats and the
 * numbers as JSON) or CSV (spreadsheet). Same access and period rules as the page.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams;
  const format = sp.get("formato") === "csv" ? "csv" : "md";
  const result = await buildAiCosts(
    periodInputFrom({ periodo: sp.get("periodo"), desde: sp.get("desde"), hasta: sp.get("hasta") }),
    baselineInputFrom({ comparar: sp.get("comparar"), cdesde: sp.get("cdesde"), chasta: sp.get("chasta") }),
  );
  if (!result.ok) {
    return Response.json({ error: result.error }, { status: result.status, headers: { "Cache-Control": "private, no-store" } });
  }
  const body = format === "csv" ? renderAiCostCsv(result.data) : renderAiCostMarkdown(result.data);
  const name = `${reportFileStem(result.data)}.${format}`;
  // The BOM makes Excel read the CSV as UTF-8 (accents in business names).
  return new Response(format === "csv" ? "﻿" + body : body, {
    headers: {
      "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
