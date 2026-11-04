import "server-only";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listClientModulesForTenant } from "@worker/db/repositories/clientModules.js";
import { countPendingForClient } from "@worker/db/repositories/handoff.js";
import { getOpenAiConnectionStatus, listBilledDays } from "@worker/db/repositories/openaiBilling.js";
import { countProductionExecutions, listConnectionPlans, listExecutionUsage } from "@worker/db/repositories/n8nExecutionsUsage.js";
import { planCycle, planUsageOf, type PlanUsage } from "@worker/analytics/executionsModel.js";
import { CHART_COLORS } from "@worker/analytics/chartColors.js";
import { tenantChartSlots } from "./chartSlots";
import { buildEnabledModulesMap } from "./enabledModulesMap";
import { AI_COSTS_TZ } from "./aiCosts";
import { isR2Configured } from "./r2";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import type { ClientFolderView, ClientOption, WorkflowItem } from "@/components/ClientsWorkflowsView";

/**
 * The agency's home (`/`) — SERVER ONLY, for a full-access scope (the page gates first).
 * What needs attention, every business with its doors (Inbox, value dashboard, agenda) AND its
 * management (create, rename, color, logo, modules, members, delete, move workflows — what
 * «Clientes y workflows» used to be), and the agency tools with one status line each. Every read
 * is tenant-scoped; counts only, no conversation content.
 */

export interface HomeBusiness {
  id: string;
  name: string;
  logoUrl: string | null;
  /** Light/dark hex of its chart color (chosen in the business ⋯ menu, else automatic). */
  color: { light: string; dark: string } | null;
  workflows: number;
  /** Production executions of its workflows in the last 30 days. */
  executions30d: number;
  pending: number;
  hasInbox: boolean;
  hasAgenda: boolean;
}

export interface HomeReview {
  kind: "inbox" | "plan" | "openai";
  text: string;
  href: string;
  action: string;
}

export interface AgencyHome {
  businesses: HomeBusiness[];
  review: HomeReview[];
  /** The business management list (folders, loose workflows, move-to options). */
  manage: {
    folders: ClientFolderView[];
    looseWorkflows: WorkflowItem[];
    clientOptions: ClientOption[];
    enabledModules: Record<string, string[]>;
    r2Enabled: boolean;
  };
  agency: {
    businesses: number;
    workflows: number;
    /** What OpenAI billed so far this calendar month (UTC days); null = not connected / no data. */
    billedMonthUsd: number | null;
    /** The n8n connection closest to its limit (or the only one); null = none active. */
    plan: PlanUsage | null;
  };
}

const DAY_MS = 86_400_000;

export async function buildAgencyHome(tenantId: string, now = new Date()): Promise<AgencyHome> {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const today = now.toISOString().slice(0, 10);

  const [clients, moduleRows, usage, openai, billed, connections, slots] = await Promise.all([
    listClientsForTenant(tenantId),
    listClientModulesForTenant(tenantId),
    listExecutionUsage({ tenantId, from: since, to: now, timeZone: AI_COSTS_TZ }, "client"),
    getOpenAiConnectionStatus(tenantId),
    listBilledDays(tenantId, monthStart, today),
    listConnectionPlans(tenantId),
    tenantChartSlots(tenantId),
  ]);
  const workflows = await listWorkflowsWithClientForTenant(tenantId);
  const named = clients.filter((c) => !c.is_default).sort((x, y) => x.name.localeCompare(y.name, "es"));
  const defaultId = clients.find((c) => c.is_default)?.id ?? null;
  const modules = buildEnabledModulesMap(moduleRows, defaultId);

  const executions = new Map<string, number>();
  for (const r of usage) executions.set(r.key, (executions.get(r.key) ?? 0) + r.production);

  const [pendings, plans] = await Promise.all([
    Promise.all(named.map((c) => ((modules[c.id] ?? []).includes("inbox") ? countPendingForClient(tenantId, c.id) : Promise.resolve(0)))),
    Promise.all(
      connections.map(async (c) =>
        planUsageOf({
          connectionId: c.id,
          connectionName: c.name,
          limit: c.plan_monthly_executions,
          resetDay: c.plan_reset_day,
          used: await countProductionExecutions(tenantId, c.id, planCycle(now, c.plan_reset_day).start),
          now,
        }),
      ),
    ),
  ]);

  const businesses: HomeBusiness[] = named.map((c, i) => {
    const slot = slots[c.id];
    const color = slot ? CHART_COLORS.find((x) => x.slot === slot) ?? null : null;
    const mods = modules[c.id] ?? [];
    return {
      id: c.id,
      name: c.name,
      logoUrl: c.logo_url,
      color: color ? { light: color.light, dark: color.dark } : null,
      workflows: c.workflow_count,
      executions30d: executions.get(c.id) ?? 0,
      pending: pendings[i],
      hasInbox: mods.includes("inbox"),
      hasAgenda: mods.includes("scheduling"),
    };
  });

  // The plan worth showing: the most used share (a configured limit beats none).
  const plan = [...plans].sort((x, y) => (y.projectedPct ?? y.usedPct ?? -1) - (x.projectedPct ?? x.usedPct ?? -1))[0] ?? null;

  const review: HomeReview[] = [];
  for (const b of businesses) {
    if (b.pending > 0) {
      review.push({
        kind: "inbox",
        text: `${b.pending} ${b.pending === 1 ? "conversación espera" : "conversaciones esperan"} respuesta humana en ${b.name}`,
        href: `/clients/${b.id}/inbox`,
        action: "Abrir Inbox",
      });
    }
  }
  for (const p of plans) {
    if (p.projectedPct !== null && p.projectedPct >= 90) {
      review.push({
        kind: "plan",
        text: `${p.connectionName}: al ritmo actual el ciclo cierra en ~${Math.round(p.projectedPct)} % del plan de n8n`,
        href: "/costos-ia?vista=ejecuciones",
        action: "Ver ejecuciones",
      });
    }
  }
  if (openai?.last_sync_error) {
    review.push({ kind: "openai", text: "La sincronización con OpenAI falló: la factura puede estar desactualizada", href: "/costos-ia", action: "Revisar" });
  }

  const byName = (a: WorkflowItem, b: WorkflowItem) => (a.name ?? a.n8nWorkflowId).localeCompare(b.name ?? b.n8nWorkflowId, "es");
  const byClient = new Map<string, WorkflowItem[]>();
  for (const w of workflows) {
    const item: WorkflowItem = { id: w.id, n8nWorkflowId: w.n8n_workflow_id, name: w.name, active: w.active, clientId: w.client_id };
    const list = byClient.get(w.client_id);
    if (list) list.push(item);
    else byClient.set(w.client_id, [item]);
  }
  const manage = {
    folders: named.map((c) => ({
      id: c.id,
      name: c.name,
      logoUrl: c.logo_url,
      chartColor: c.chart_color,
      workflowCount: c.workflow_count,
      workflows: (byClient.get(c.id) ?? []).sort(byName),
    })),
    looseWorkflows: (byClient.get(defaultId ?? "") ?? []).sort(byName),
    clientOptions: [
      ...(defaultId ? [{ id: defaultId, name: "Sin negocio", isDefault: true }] : []),
      ...named.map((c) => ({ id: c.id, name: c.name, isDefault: false })),
    ],
    enabledModules: modules,
    r2Enabled: isR2Configured,
  };

  return {
    businesses,
    review,
    manage,
    agency: {
      businesses: named.length,
      workflows: clients.reduce((n, c) => n + c.workflow_count, 0),
      billedMonthUsd: openai && billed.length > 0 ? billed.reduce((n, d) => n + d.amount_usd, 0) : null,
      plan,
    },
  };
}
