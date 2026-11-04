import "server-only";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { assignChartColors, type ChartColorSlot } from "@worker/analytics/chartColors.js";

/**
 * Each business's chart color slot, assigned ONCE across the whole tenant (its chosen color
 * first, the rest by name), so a business has the same color on every screen and in every
 * period — never one that depends on which businesses happened to have data. The default
 * client (no business) is left out: it is drawn gray.
 */
export async function tenantChartSlots(tenantId: string): Promise<Record<string, ChartColorSlot>> {
  const named = (await listClientsForTenant(tenantId)).filter((c) => !c.is_default);
  const slots = assignChartColors(named.map((c) => ({ key: c.id, name: c.name, chartColor: c.chart_color })));
  const out: Record<string, ChartColorSlot> = {};
  for (const [k, v] of slots) if (v) out[k] = v;
  return out;
}
