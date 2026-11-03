import "server-only";
import { getSessionScope, hasFullAccess, type AccessScope } from "./access";
import { resolveValueAccess } from "./valueDashboard";
import { getUsdCop } from "./usdCop";
import { isUuid } from "./clientModuleValidation";
import { getClientById, listClientsForTenant } from "@worker/db/repositories/clients.js";
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
  getOpenAiConnectionStatus,
  listBilledByDayProject,
  listBilledDays,
  listBilledLines,
  listBilledModels,
  listClientProjectMap,
  listOpenAiProjects,
  type BilledDayRow,
  type BilledLineRow,
  type BilledModelRow,
  type OpenAiProjectView,
} from "@worker/db/repositories/openaiBilling.js";
import { splitBilling, type BillingSplit, type ClientSplit, type DayTokens } from "@worker/analytics/billingSplit.js";
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
  /** What OpenAI billed the organization (agency view only; null in a business view). */
  billing: OpenAiBilling | null;
  /** What OpenAI billed for THIS business (business view only, when the agency is connected). */
  clientBilling: ClientBilling | null;
}

/** One business's share of the invoice — exact (its own project) + approximate (shared). */
export interface ClientBilling {
  hasOwnProject: boolean;
  lastSyncedAt: string | null;
  current: ClientSplit | null;
  previous: ClientSplit | null;
}

/**
 * OpenAI's own figures for the same local days, read as OpenAI's UTC days (its buckets are
 * UTC). They cover the WHOLE organization — every key, project and use — so they belong to the
 * agency view only and are never split per business here.
 */
export interface OpenAiBilling {
  connected: boolean;
  keyHint: string | null;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  /** null = no data stored for the period (not connected yet, or no sync). */
  totalUsd: number | null;
  previousTotalUsd: number | null;
  days: BilledDayRow[];
  lines: BilledLineRow[];
  models: BilledModelRow[];
  /** The organization's projects and the business each is assigned to. */
  projects: OpenAiProjectView[];
  /** Every business of the tenant (for the project picker), by name. */
  businesses: Array<{ id: string; name: string }>;
  /** The invoice split by business (keyed by client id) for the period and the comparison. */
  split: BillingSplit | null;
  previousSplit: BillingSplit | null;
}

function dayTokens(d: AiCostDashboard): DayTokens[] {
  return d.daily.map((x) => ({ day: x.day, byClient: x.tokensByClient }));
}

/** The split for [fromDay, toDay], given the TENANT-WIDE usage of the same days. */
async function splitFor(tenantId: string, fromDay: string, toDay: string, usage: AiCostDashboard, projectOf: Record<string, string>) {
  const billed = await listBilledByDayProject(tenantId, fromDay, toDay);
  if (billed.length === 0) return null;
  return splitBilling({ billed: billed.map((b) => ({ day: b.day, projectId: b.project_id, usd: b.amount_usd })), projectOf, tokens: dayTokens(usage) });
}

async function projectMap(tenantId: string): Promise<Record<string, string>> {
  return Object.fromEntries((await listClientProjectMap(tenantId)).map((m) => [m.client_id, m.openai_project_id]));
}

async function loadBilling(
  tenantId: string,
  period: Period,
  baseline: Baseline,
  usage: { current: AiCostDashboard; previous: AiCostDashboard },
): Promise<OpenAiBilling> {
  const projectOf = await projectMap(tenantId);
  const [status, days, prevDays, lines, models, projects, split, previousSplit, clients] = await Promise.all([
    getOpenAiConnectionStatus(tenantId),
    listBilledDays(tenantId, period.fromDay, period.toDay),
    listBilledDays(tenantId, baseline.fromDay, baseline.toDay),
    listBilledLines(tenantId, period.fromDay, period.toDay),
    listBilledModels(tenantId, period.fromDay, period.toDay),
    listOpenAiProjects(tenantId),
    splitFor(tenantId, period.fromDay, period.toDay, usage.current, projectOf),
    splitFor(tenantId, baseline.fromDay, baseline.toDay, usage.previous, projectOf),
    listClientsForTenant(tenantId),
  ]);
  const sum = (rows: BilledDayRow[]) => (rows.length ? rows.reduce((n, r) => n + r.amount_usd, 0) : null);
  return {
    connected: status !== null,
    keyHint: status?.key_hint ?? null,
    lastSyncedAt: status?.last_synced_at ? status.last_synced_at.toISOString() : null,
    lastSyncError: status?.last_sync_error ?? null,
    totalUsd: sum(days),
    previousTotalUsd: sum(prevDays),
    days,
    lines,
    models,
    projects,
    businesses: clients
      .filter((c) => !c.is_default)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((x, y) => x.name.localeCompare(y.name, "es")),
    split,
    previousSplit,
  };
}

/**
 * A business's own share. The shared part needs EVERY business's usage of those days (otherwise
 * the whole shared pool would land on this one), so the tenant-wide usage is read here — and only
 * this business's resulting figure leaves the server.
 */
async function loadClientBilling(tenantId: string, clientId: string, period: Period, baseline: Baseline): Promise<ClientBilling | null> {
  const status = await getOpenAiConnectionStatus(tenantId);
  if (!status) return null;
  const projectOf = await projectMap(tenantId);
  const wide = (startUtc: string, endUtc: string, days: string[]) =>
    loadDashboard({ tenantId, clientId: null, from: new Date(startUtc), to: new Date(endUtc), timeZone: AI_COSTS_TZ }, days);
  const [curUsage, prevUsage] = await Promise.all([
    wide(period.startUtc, period.endUtc, periodDays(period)),
    wide(baseline.startUtc, baseline.endUtc, periodDays({ fromDay: baseline.fromDay, days: baseline.days })),
  ]);
  const [cur, prev] = await Promise.all([
    splitFor(tenantId, period.fromDay, period.toDay, curUsage, projectOf),
    splitFor(tenantId, baseline.fromDay, baseline.toDay, prevUsage, projectOf),
  ]);
  return {
    hasOwnProject: clientId in projectOf,
    lastSyncedAt: status.last_synced_at ? status.last_synced_at.toISOString() : null,
    current: cur ? cur.byClient[clientId] ?? { exactUsd: 0, sharedUsd: 0, totalUsd: 0 } : null,
    previous: prev ? prev.byClient[clientId] ?? { exactUsd: 0, sharedUsd: 0, totalUsd: 0 } : null,
  };
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
  const [billing, clientBilling] = await Promise.all([
    access.client ? Promise.resolve(null) : loadBilling(tenantId, period, baseline, { current, previous }),
    access.client ? loadClientBilling(tenantId, access.client.id, period, baseline) : Promise.resolve(null),
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
      billing,
      clientBilling,
    },
  };
}
