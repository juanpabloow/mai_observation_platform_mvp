import "server-only";
import { getSessionScope, hasFullAccess, type AccessScope } from "./access";
import { resolveValueAccess } from "./valueDashboard";
import { getUsdCop } from "./usdCop";
import { isUuid } from "./clientModuleValidation";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  buildAiCostDashboard,
  compareAiCosts,
  type AiCostComparison,
  type AiCostDashboard,
} from "@worker/analytics/aiCostModel.js";
import { periodDays, resolvePeriod, type Period, type PeriodInput } from "@worker/analytics/valueDashboardModel.js";
import { resolveBaseline, type Baseline, type BaselineInput } from "@worker/analytics/aiCostPeriods.js";
import type { UsdCop } from "@worker/analytics/usdCop.js";
import {
  listAiClientActivity,
  listAiCoverage,
  listAiMeetingRows,
  listAiUsageRows,
  type AiCostPeriod,
} from "@worker/db/repositories/llmUsage.js";

/**
 * COSTOS DE IA — access + assembly, SERVER ONLY. Used by the pages, the period API and the
 * report download, so all of them apply the same rule:
 *   - all businesses (`/costos-ia`): the agency only (tenant owner/admin, `hasFullAccess`);
 *   - one business (`/clients/{id}/costos-ia`, `?cliente=`): the value dashboard's rule —
 *     the agency or whoever holds `analytics.view` on THAT business (its owner), and the
 *     business must belong to the session's tenant.
 * Everyone else gets 404; no session, 401. Every read is tenant-scoped, and a business view
 * filters every query by that business.
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
  /** The business this view is limited to; null = every business (agency view). */
  client: { id: string; name: string } | null;
  /** COP per USD (today's TRM, or the manual fallback); null when neither is available. */
  usdCop: number | null;
  /** Where `usdCop` came from, for the screen's note. */
  fx: UsdCop | null;
  current: AiCostDashboard;
  previous: AiCostDashboard;
  comparison: AiCostComparison;
}

export type AiCostsResult =
  | { ok: true; data: AiCostsReport }
  | { ok: false; status: 400 | 401 | 404; error: string };

type Access = { ok: true; scope: AccessScope; client: { id: string; name: string } | null } | { ok: false; status: 401 | 404 };

export async function resolveAiCostsAccess(clientId?: string | null): Promise<Access> {
  if (clientId) {
    if (!isUuid(clientId)) return { ok: false, status: 404 };
    const v = await resolveValueAccess(clientId); // agency, or analytics.view on this business, same tenant
    if (!v.ok) return { ok: false, status: v.status };
    const c = await getClientById({ tenantId: v.scope.tenantId, clientId });
    if (!c || c.is_default) return { ok: false, status: 404 };
    return { ok: true, scope: v.scope, client: { id: c.id, name: c.name } };
  }
  const scope = await getSessionScope();
  if (!scope) return { ok: false, status: 401 };
  if (!hasFullAccess(scope)) return { ok: false, status: 404 };
  return { ok: true, scope, client: null };
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

export async function buildAiCosts(
  input: PeriodInput,
  baselineInput: BaselineInput = { key: "anterior" },
  options: { clientId?: string | null; now?: Date } = {},
): Promise<AiCostsResult> {
  const now = options.now ?? new Date();
  const access = await resolveAiCostsAccess(options.clientId);
  if (!access.ok) return { ok: false, status: access.status, error: access.status === 401 ? "unauthorized" : "not_found" };
  const r = resolvePeriod(input, now, AI_COSTS_TZ);
  if (!r.ok) return { ok: false, status: 400, error: r.error };
  const period = r.period;
  const b = resolveBaseline(period, baselineInput, AI_COSTS_TZ);
  if (!b.ok) return { ok: false, status: 400, error: b.error };
  const baseline = b.baseline;
  const tenantId = access.scope.tenantId;
  const clientId = access.client?.id ?? null;
  const [current, previous, fx] = await Promise.all([
    loadDashboard(
      { tenantId, clientId, from: new Date(period.startUtc), to: new Date(period.endUtc), timeZone: AI_COSTS_TZ },
      periodDays(period),
    ),
    loadDashboard(
      { tenantId, clientId, from: new Date(baseline.startUtc), to: new Date(baseline.endUtc), timeZone: AI_COSTS_TZ },
      periodDays({ fromDay: baseline.fromDay, days: baseline.days }),
    ),
    getUsdCop(),
  ]);
  return {
    ok: true,
    data: {
      period,
      baseline,
      tz: AI_COSTS_TZ,
      generatedAt: now.toISOString(),
      client: access.client,
      usdCop: fx?.rate ?? null,
      fx,
      current,
      previous,
      comparison: compareAiCosts(current, previous, { current: period.days, previous: baseline.days }),
    },
  };
}
