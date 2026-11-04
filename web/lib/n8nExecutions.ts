import "server-only";
import { AI_COSTS_TZ, pick, resolveAiCostsAccess } from "./aiCosts";
import { tenantChartSlots } from "./chartSlots";
import type { ChartColorSlot } from "@worker/analytics/chartColors.js";
import { periodDays, resolvePeriod, type Period, type PeriodInput } from "@worker/analytics/valueDashboardModel.js";
import { resolveBaseline, type Baseline, type BaselineInput } from "@worker/analytics/aiCostPeriods.js";
import {
  buildExecDashboard,
  buildUsageBreakdown,
  compareExecutions,
  planCycle,
  planUsageOf,
  type ExecComparison,
  type ExecDashboard,
  type PlanUsage,
  type UsageBreakdown,
} from "@worker/analytics/executionsModel.js";
import {
  countProductionExecutions,
  listConnectionPlans,
  listExecutionDays,
  listExecutionEndings,
  listExecutionUsage,
  getInboxSends,
  type ExecPeriod,
  type InboxSendsRow,
} from "@worker/db/repositories/n8nExecutionsUsage.js";

/**
 * COSTOS DE IA → Ejecuciones — access + assembly, SERVER ONLY. Same rule as the costs screen
 * (resolveAiCostsAccess): every business = the agency only; one business = the agency or that
 * business's owner (`analytics.view`). Same periods and comparison choices.
 *
 * The n8n PLAN belongs to the agency (one per n8n connection, shared by all its businesses), so
 * a business view never gets it — only its own executions.
 */

export interface ExecutionsReport {
  period: Period;
  baseline: Baseline;
  tz: string;
  generatedAt: string;
  client: { id: string; name: string } | null;
  current: ExecDashboard;
  previous: ExecDashboard;
  comparison: ExecComparison;
  /** Agency view only: plan usage per n8n connection, for the CURRENT cycle (not the period). */
  plans: PlanUsage[] | null;
  /** Who uses the platform most: per business (agency view only) and per workflow. */
  usage: { byClient: UsageBreakdown | null; byWorkflow: UsageBreakdown };
  /** Chart color slot per business, assigned tenant-wide (a business view gets only its own). */
  chartSlots: Record<string, ChartColorSlot>;
  /** Replies sent by people from the Inbox in the period (accepted / failed / pending). */
  sends: InboxSendsRow;
}

export type ExecutionsResult =
  | { ok: true; data: ExecutionsReport }
  | { ok: false; status: 400 | 401 | 404; error: string };

async function loadDashboard(p: ExecPeriod, days: string[], withEndings: boolean): Promise<ExecDashboard> {
  const [rows, endings] = await Promise.all([listExecutionDays(p), withEndings ? listExecutionEndings(p) : Promise.resolve([])]);
  return buildExecDashboard({ days, rows, endings });
}

async function loadPlans(tenantId: string, now: Date): Promise<PlanUsage[]> {
  const conns = await listConnectionPlans(tenantId);
  return Promise.all(
    conns.map(async (c) => {
      const used = await countProductionExecutions(tenantId, c.id, planCycle(now, c.plan_reset_day).start);
      return planUsageOf({ connectionId: c.id, connectionName: c.name, limit: c.plan_monthly_executions, resetDay: c.plan_reset_day, used, now });
    }),
  );
}

export async function buildExecutions(
  input: PeriodInput,
  baselineInput: BaselineInput = { key: "anterior" },
  options: { clientId?: string | null; now?: Date } = {},
): Promise<ExecutionsResult> {
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
  const cur: ExecPeriod = { tenantId, clientId, from: new Date(period.startUtc), to: new Date(period.endUtc), timeZone: AI_COSTS_TZ };
  const prev: ExecPeriod = { tenantId, clientId, from: new Date(baseline.startUtc), to: new Date(baseline.endUtc), timeZone: AI_COSTS_TZ };
  const days = periodDays(period);
  const breakdown = async (by: "client" | "workflow") => {
    const [rows, previousRows] = await Promise.all([listExecutionUsage(cur, by), listExecutionUsage(prev, by)]);
    return buildUsageBreakdown({ days, rows, previousRows, periodDays: { current: period.days, previous: baseline.days } });
  };
  const [current, previous, plans, byClient, byWorkflow, allSlots, sends] = await Promise.all([
    loadDashboard(cur, days, true),
    loadDashboard(prev, periodDays({ fromDay: baseline.fromDay, days: baseline.days }), false),
    access.client ? Promise.resolve(null) : loadPlans(tenantId, now),
    access.client ? Promise.resolve(null) : breakdown("client"),
    breakdown("workflow"),
    tenantChartSlots(tenantId),
    getInboxSends(cur),
  ]);
  return {
    ok: true,
    data: {
      period,
      baseline,
      tz: AI_COSTS_TZ,
      generatedAt: now.toISOString(),
      client: access.client,
      current,
      previous,
      comparison: compareExecutions(current, previous, { current: period.days, previous: baseline.days }),
      plans,
      usage: { byClient, byWorkflow },
      chartSlots: access.client ? pick(allSlots, access.client.id) : allSlots,
      sends,
    },
  };
}
