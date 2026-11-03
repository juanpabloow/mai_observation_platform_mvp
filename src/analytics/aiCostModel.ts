import { LLM_PRICES, llmCostUsd, priceKeyFor, type ModelPrice } from './llmPricing.js';
import type {
  AiClientActivityRow,
  AiCoverageRow,
  AiMeetingsRow,
  AiUsageRow,
} from '../db/repositories/llmUsage.js';

/**
 * COSTOS DE IA — pure model of the screen: aggregates the repository rows and prices them.
 *
 * Money rules (same as the value dashboard): an unknown amount is null, never 0. A group whose
 * models are only partly priced keeps the priced sum and says `partial`; a group with no priced
 * model at all is null. Every bot amount is an ESTIMATE at list price (see `estimateCalls`).
 */

export interface Money {
  usd: number | null;
  /** Some tokens in this group belong to a model without a price. */
  partial: boolean;
}

export interface TokenTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: Money;
}

export interface ClientCost extends TokenTotals {
  clientId: string | null;
  clientName: string;
  conversations: number;
  botAppointments: number;
  perConversationUsd: number | null;
  perAppointmentUsd: number | null;
}

export interface WorkflowCost extends TokenTotals {
  workflowId: string;
  workflowName: string;
  clientName: string;
  models: string[];
  executions: number;
  perExecutionUsd: number | null;
  coverage: { total: number; scanned: number; withoutData: number };
}

export interface ModelCost extends TokenTotals {
  model: string | null;
  source: 'provider' | 'estimate';
  price: (ModelPrice & { key: string }) | null;
}

export interface DayCost {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number | null;
  /** Priced US$ of the day per business, keyed by client id ('' = unassigned). */
  byClient: Record<string, number>;
}

export interface MeetingsCost {
  analyses: number;
  inputTokens: number;
  outputTokens: number;
  cost: Money;
}

export interface AiCostDashboard {
  days: string[];
  totals: TokenTotals & { estimateCalls: number; conversations: number; botAppointments: number };
  byClient: ClientCost[];
  byWorkflow: WorkflowCost[];
  byModel: ModelCost[];
  daily: DayCost[];
  meetings: MeetingsCost;
  coverage: { total: number; scanned: number; unscanned: number; withoutData: number };
  prices: Array<ModelPrice & { model: string }>;
}

const UNASSIGNED = 'Sin negocio asignado';

function blank(): TokenTotals {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cost: { usd: null, partial: false } };
}

function addUsage(t: TokenTotals, row: { calls: number; input_tokens: number; output_tokens: number }, usd: number | null): void {
  t.calls += row.calls;
  t.inputTokens += row.input_tokens;
  t.outputTokens += row.output_tokens;
  addMoney(t.cost, usd, row.input_tokens + row.output_tokens > 0);
}

function addMoney(m: Money, usd: number | null, hasTokens: boolean): void {
  if (usd === null) {
    if (hasTokens) m.partial = true;
    return;
  }
  m.usd = (m.usd ?? 0) + usd;
}

/** A partial money total (some tokens unpriced) is not a price: the ratio would undercount. */
function ratio(m: Money, n: number): number | null {
  return m.usd === null || m.partial || n <= 0 ? null : m.usd / n;
}

export function buildAiCostDashboard(input: {
  days: string[];
  usage: AiUsageRow[];
  coverage: AiCoverageRow[];
  activity: AiClientActivityRow[];
  meetings: AiMeetingsRow[];
}): AiCostDashboard {
  const totals = { ...blank(), estimateCalls: 0, conversations: 0, botAppointments: 0 };
  const clients = new Map<string, ClientCost>();
  const workflows = new Map<string, WorkflowCost>();
  const models = new Map<string, ModelCost>();
  const daily = new Map<string, DayCost>(
    input.days.map((day) => [day, { day, calls: 0, inputTokens: 0, outputTokens: 0, usd: null, byClient: {} }]),
  );
  const coverageByWf = new Map(input.coverage.map((c) => [c.n8n_workflow_id, c]));

  const clientOf = (id: string | null, name: string | null): ClientCost => {
    const key = id ?? '';
    let c = clients.get(key);
    if (!c) {
      c = { ...blank(), clientId: id, clientName: name ?? UNASSIGNED, conversations: 0, botAppointments: 0, perConversationUsd: null, perAppointmentUsd: null };
      clients.set(key, c);
    }
    return c;
  };

  for (const row of input.usage) {
    const usd = llmCostUsd(row.model, row.input_tokens, row.output_tokens);
    addUsage(totals, row, usd);
    if (row.usage_source === 'estimate') totals.estimateCalls += row.calls;

    addUsage(clientOf(row.client_id, row.client_name), row, usd);

    let wf = workflows.get(row.n8n_workflow_id);
    if (!wf) {
      const cov = coverageByWf.get(row.n8n_workflow_id);
      wf = {
        ...blank(), workflowId: row.n8n_workflow_id, workflowName: row.workflow_name ?? row.n8n_workflow_id,
        clientName: row.client_name ?? UNASSIGNED, models: [], executions: 0, perExecutionUsd: null,
        coverage: { total: cov?.total ?? 0, scanned: cov?.scanned ?? 0, withoutData: cov?.without_data ?? 0 },
      };
      workflows.set(row.n8n_workflow_id, wf);
    }
    addUsage(wf, row, usd);
    wf.executions += row.executions; // an execution with two models counts once per model row
    const label = row.model ?? 'modelo desconocido';
    if (!wf.models.includes(label)) wf.models.push(label);

    const mKey = `${row.model ?? ''}\u0000${row.usage_source}`;
    let m = models.get(mKey);
    if (!m) {
      const key = priceKeyFor(row.model);
      m = { ...blank(), model: row.model, source: row.usage_source, price: key ? { key, ...LLM_PRICES[key] } : null };
      models.set(mKey, m);
    }
    addUsage(m, row, usd);

    const d = daily.get(row.day);
    if (d) {
      d.calls += row.calls;
      d.inputTokens += row.input_tokens;
      d.outputTokens += row.output_tokens;
      if (usd !== null) {
        d.usd = (d.usd ?? 0) + usd;
        const ck = row.client_id ?? '';
        d.byClient[ck] = (d.byClient[ck] ?? 0) + usd;
      }
    }
  }

  for (const a of input.activity) {
    const c = clients.get(a.client_id);
    totals.conversations += a.conversations;
    totals.botAppointments += a.bot_appointments;
    if (!c) continue; // activity without model usage: nothing to divide
    c.conversations = a.conversations;
    c.botAppointments = a.bot_appointments;
  }
  for (const c of clients.values()) {
    c.perConversationUsd = ratio(c.cost, c.conversations);
    c.perAppointmentUsd = ratio(c.cost, c.botAppointments);
  }
  for (const w of workflows.values()) w.perExecutionUsd = ratio(w.cost, w.executions);

  const meetings: MeetingsCost = { analyses: 0, inputTokens: 0, outputTokens: 0, cost: { usd: null, partial: false } };
  for (const m of input.meetings) {
    meetings.analyses += m.analyses;
    meetings.inputTokens += m.input_tokens;
    meetings.outputTokens += m.output_tokens;
    if (m.cost_usd !== null) meetings.cost.usd = (meetings.cost.usd ?? 0) + m.cost_usd;
    if (m.unpriced > 0) meetings.cost.partial = true;
  }

  const coverage = { total: 0, scanned: 0, unscanned: 0, withoutData: 0 };
  for (const c of input.coverage) {
    coverage.total += c.total;
    coverage.scanned += c.scanned;
    coverage.withoutData += c.without_data;
  }
  coverage.unscanned = coverage.total - coverage.scanned;

  const byCost = (a: TokenTotals, b: TokenTotals) =>
    (b.cost.usd ?? -1) - (a.cost.usd ?? -1) || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);

  return {
    days: input.days,
    totals,
    byClient: [...clients.values()].sort(byCost),
    byWorkflow: [...workflows.values()].sort(byCost),
    byModel: [...models.values()].sort(byCost),
    daily: [...daily.values()],
    meetings,
    coverage,
    prices: Object.entries(LLM_PRICES).map(([model, p]) => ({ model, ...p })),
  };
}

/* ------------------------------------------------------------ comparison -- */

/**
 * Ratios that stay comparable between periods: they move when the BOT changes (a shorter prompt
 * lowers input tokens per call, fewer tool loops lower calls per execution) and not only when
 * traffic does. Null = unknown (no denominator, or money with unpriced tokens).
 */
export interface AiCostMetrics {
  costUsd: number | null;
  perConversationUsd: number | null;
  inputPerCall: number | null;
  outputPerCall: number | null;
  callsPerExecution: number | null;
  calls: number;
  executions: number;
  conversations: number;
}

export function metricsOf(d: AiCostDashboard): AiCostMetrics {
  const executions = d.byWorkflow.reduce((n, w) => n + w.executions, 0);
  const t = d.totals;
  const exactCost = t.cost.partial ? null : t.cost.usd ?? (t.calls === 0 ? 0 : null);
  return {
    costUsd: exactCost,
    perConversationUsd: exactCost !== null && t.conversations > 0 ? exactCost / t.conversations : null,
    inputPerCall: t.calls > 0 ? t.inputTokens / t.calls : null,
    outputPerCall: t.calls > 0 ? t.outputTokens / t.calls : null,
    callsPerExecution: executions > 0 ? t.calls / executions : null,
    calls: t.calls,
    executions,
    conversations: t.conversations,
  };
}

export type Change =
  | { kind: 'pct'; pct: number }
  | { kind: 'no_prev' }
  | { kind: 'unavailable'; reason: string };

export interface ComparisonStatus {
  available: boolean;
  reason: string | null;
}

/** The comparison period is only a fair baseline when every one of its executions was read. */
export function comparisonStatus(previous: AiCostDashboard): ComparisonStatus {
  if (previous.coverage.unscanned > 0) {
    return { available: false, reason: 'el periodo de comparación tiene ejecuciones sin leer (corre el backfill)' };
  }
  return { available: true, reason: null };
}

export function changeOf(cur: number | null, prev: number | null, status: ComparisonStatus): Change {
  if (!status.available) return { kind: 'unavailable', reason: status.reason ?? 'sin comparación' };
  if (cur === null || prev === null) return { kind: 'unavailable', reason: 'falta un dato en uno de los dos periodos' };
  if (prev === 0) return cur === 0 ? { kind: 'pct', pct: 0 } : { kind: 'no_prev' };
  return { kind: 'pct', pct: Math.round(((cur - prev) / prev) * 1000) / 10 };
}

export type MetricKey = keyof AiCostMetrics;

/** Which direction is an improvement. `neutral` = volume: more is not good or bad by itself. */
export const METRIC_DIRECTION: Record<MetricKey, 'lower' | 'neutral'> = {
  costUsd: 'lower',
  perConversationUsd: 'lower',
  inputPerCall: 'lower',
  outputPerCall: 'lower',
  callsPerExecution: 'lower',
  calls: 'neutral',
  executions: 'neutral',
  conversations: 'neutral',
};

export interface AiCostComparison {
  status: ComparisonStatus;
  current: AiCostMetrics;
  previous: AiCostMetrics;
  changes: Record<MetricKey, Change>;
  /** Per workflow, by id: cost and the two prompt-size ratios. */
  workflows: Record<string, { costUsd: Change; inputPerCall: Change; callsPerExecution: Change }>;
  /** Per client, by id ('' = unassigned): cost and cost per conversation. */
  clients: Record<string, { costUsd: Change; perConversationUsd: Change }>;
  /** The two periods have different lengths: totals were compared as daily averages. */
  perDay: boolean;
}

/** Totals that grow with the length of the period (ratios do not). */
const TOTAL_KEYS = new Set<MetricKey>(['costUsd', 'calls', 'executions', 'conversations']);

const exactUsd = (m: Money) => (m.partial ? null : m.usd);

export function compareAiCosts(
  current: AiCostDashboard,
  previous: AiCostDashboard,
  days: { current: number; previous: number } = { current: 1, previous: 1 },
): AiCostComparison {
  const status = comparisonStatus(previous);
  const cur = metricsOf(current);
  const prev = metricsOf(previous);
  // Different lengths: a total is compared as a daily average, so 14 days vs 30 is still fair.
  const perDay = days.current !== days.previous && days.current > 0 && days.previous > 0;
  const scale = perDay ? days.current / days.previous : 1;
  const scaled = (v: number | null) => (v === null ? null : v * scale);
  const changes = Object.fromEntries(
    (Object.keys(cur) as MetricKey[]).map((k) => [k, changeOf(cur[k], TOTAL_KEYS.has(k) ? scaled(prev[k]) : prev[k], status)]),
  ) as Record<MetricKey, Change>;

  const prevWf = new Map(previous.byWorkflow.map((w) => [w.workflowId, w]));
  const workflows: AiCostComparison['workflows'] = {};
  for (const w of current.byWorkflow) {
    const p = prevWf.get(w.workflowId);
    const perCall = (x: WorkflowCost | undefined) => (x && x.calls > 0 ? x.inputTokens / x.calls : null);
    const perExec = (x: WorkflowCost | undefined) => (x && x.executions > 0 ? x.calls / x.executions : null);
    workflows[w.workflowId] = {
      costUsd: changeOf(exactUsd(w.cost), p ? scaled(exactUsd(p.cost)) : 0, status),
      inputPerCall: p ? changeOf(perCall(w), perCall(p), status) : { kind: 'no_prev' },
      callsPerExecution: p ? changeOf(perExec(w), perExec(p), status) : { kind: 'no_prev' },
    };
  }
  const prevCl = new Map(previous.byClient.map((c) => [c.clientId ?? '', c]));
  const clients: AiCostComparison['clients'] = {};
  for (const c of current.byClient) {
    const p = prevCl.get(c.clientId ?? '');
    clients[c.clientId ?? ''] = {
      costUsd: changeOf(exactUsd(c.cost), p ? scaled(exactUsd(p.cost)) : 0, status),
      perConversationUsd: p ? changeOf(c.perConversationUsd, p.perConversationUsd, status) : { kind: 'no_prev' },
    };
  }
  return { status, current: cur, previous: prev, changes, workflows, clients, perDay };
}
