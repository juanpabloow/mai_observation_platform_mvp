import "server-only";
import { getSessionScope, hasFullAccess, type AccessScope } from "./access";
import {
  buildAiCostDashboard,
  compareAiCosts,
  type AiCostComparison,
  type AiCostDashboard,
} from "@worker/analytics/aiCostModel.js";
import { periodDays, resolvePeriod, type Period, type PeriodInput } from "@worker/analytics/valueDashboardModel.js";
import { resolveBaseline, type Baseline, type BaselineInput } from "@worker/analytics/aiCostPeriods.js";
import {
  listAiClientActivity,
  listAiCoverage,
  listAiMeetingRows,
  listAiUsageRows,
  type AiCostPeriod,
} from "@worker/db/repositories/llmUsage.js";

/**
 * COSTOS DE IA — access + assembly, SERVER ONLY. Used by the page, the period API and the report
 * download, so all three apply the same rule: the agency (tenant owner/admin, `hasFullAccess`).
 * Everyone else gets 404; no session, 401. Every read is scoped to the session's tenant.
 *
 * Periods follow the value dashboard exactly (7 días / 30 días / personalizado ≤ 92 días, local
 * days in Bogotá). The comparison period is the window right before (default), the same dates one
 * month earlier, or any custom range (aiCostPeriods.ts).
 */
export const AI_COSTS_TZ = "America/Bogota";

export interface AiCostsReport {
  period: Period;
  baseline: Baseline;
  tz: string;
  generatedAt: string;
  /** COP per USD from USD_COP_RATE; null when unset or invalid (COP is then not shown). */
  usdCop: number | null;
  current: AiCostDashboard;
  previous: AiCostDashboard;
  comparison: AiCostComparison;
}

export type AiCostsResult =
  | { ok: true; data: AiCostsReport }
  | { ok: false; status: 400 | 401 | 404; error: string };

export function usdCopRate(raw: string | undefined = process.env.USD_COP_RATE): number | null {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : null;
}

export async function resolveAiCostsAccess(): Promise<{ ok: true; scope: AccessScope } | { ok: false; status: 401 | 404 }> {
  const scope = await getSessionScope();
  if (!scope) return { ok: false, status: 401 };
  if (!hasFullAccess(scope)) return { ok: false, status: 404 };
  return { ok: true, scope };
}

async function loadDashboard(p: AiCostPeriod, days: string[]): Promise<AiCostDashboard> {
  const [usage, coverage, activity, meetings] = await Promise.all([
    listAiUsageRows(p),
    listAiCoverage(p),
    listAiClientActivity(p),
    listAiMeetingRows(p),
  ]);
  return buildAiCostDashboard({ days, usage, coverage, activity, meetings });
}

export async function buildAiCosts(input: PeriodInput, baselineInput: BaselineInput = { key: "anterior" }, now = new Date()): Promise<AiCostsResult> {
  const access = await resolveAiCostsAccess();
  if (!access.ok) return { ok: false, status: access.status, error: access.status === 401 ? "unauthorized" : "not_found" };
  const r = resolvePeriod(input, now, AI_COSTS_TZ);
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  const period = r.period;
  const b = resolveBaseline(period, baselineInput, AI_COSTS_TZ);
  if (!b.ok) return { ok: false, status: 400, error: b.error };
  const baseline = b.baseline;
  const tenantId = access.scope.tenantId;
  const [current, previous] = await Promise.all([
    loadDashboard(
      { tenantId, from: new Date(period.startUtc), to: new Date(period.endUtc), timeZone: AI_COSTS_TZ },
      periodDays(period),
    ),
    loadDashboard(
      { tenantId, from: new Date(baseline.startUtc), to: new Date(baseline.endUtc), timeZone: AI_COSTS_TZ },
      periodDays({ fromDay: baseline.fromDay, days: baseline.days }),
    ),
  ]);
  return {
    ok: true,
    data: {
      period,
      baseline,
      tz: AI_COSTS_TZ,
      generatedAt: now.toISOString(),
      usdCop: usdCopRate(),
      current,
      previous,
      comparison: compareAiCosts(current, previous, { current: period.days, previous: baseline.days }),
    },
  };
}
