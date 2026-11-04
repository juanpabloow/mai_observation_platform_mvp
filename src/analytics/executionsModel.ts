import { changeOf, type Change, type ComparisonStatus } from './aiCostModel.js';
import type { ExecDayRow, ExecEndingRow, ExecUsageRow } from '../db/repositories/n8nExecutionsUsage.js';

/**
 * COSTOS DE IA → Ejecuciones — pure model: how many PRODUCTION executions n8n counted (what the
 * plan bills), how many of them reached the model (the bot answered), how many stopped before
 * (WhatsApp status notices, filters, human mode…), and how that changed against the comparison
 * period. Manual runs (editor tests) are shown apart and never counted against the plan.
 *
 * Unknown is never zero: an execution not read yet, or one n8n kept no data for, is «sin leer»
 * and is left OUT of the shares (waste %, executions per answer) instead of being read as "no AI".
 */

export interface ExecDay {
  day: string;
  production: number;
  durationMsSum: number;
  durationN: number;
  manual: number;
  withAi: number;
  noAi: number;
  errors: number;
  unread: number;
}

export interface ExecTotals {
  production: number;
  manual: number;
  withAi: number;
  noAi: number;
  errors: number;
  unread: number;
}

/** One business or workflow: its production executions, share of the total, and its days. */
export interface UsageEntity extends ExecTotals {
  key: string;
  name: string;
  /** Business palette slot, or null (automatic / workflows). */
  chartColor: string | null;
  /** The «Otros» bucket that folds everything past the first USAGE_MAX_SERIES - 1. */
  isOther: boolean;
  wastePct: number | null;
  sharePct: number | null;
  /** Production executions per day, aligned with the dashboard's days. */
  daily: number[];
  /** Against the same entity in the comparison period (per day when the periods differ). */
  change: Change;
}

export interface UsageBreakdown {
  entities: UsageEntity[];
  total: number;
}

export interface ExecEnding {
  workflow: string;
  clientName: string;
  lastNode: string;
  manual: boolean;
  executions: number;
  withAi: number;
  errors: number;
}

export interface ExecDashboard {
  days: ExecDay[];
  totals: ExecTotals;
  /** Average production execution duration; null when n8n reported none. */
  avgDurationMs: number | null;
  endings: ExecEnding[];
}

export interface ExecMetrics {
  production: number;
  withAi: number;
  /** % of the read production executions that did not reach the model. null = nothing read. */
  wastePct: number | null;
  /** Read production executions per execution that reached the model. null = none reached it. */
  perAnswer: number | null;
  manual: number;
  /** Average production execution duration (ms). */
  avgDurationMs: number | null;
}

export type ExecMetricKey = keyof ExecMetrics;

/** Every execution metric is better lower except the answers themselves (volume, neutral). */
export const EXEC_METRIC_DIRECTION: Record<ExecMetricKey, 'lower' | 'neutral'> = {
  production: 'lower',
  withAi: 'neutral',
  wastePct: 'lower',
  perAnswer: 'lower',
  manual: 'neutral',
  avgDurationMs: 'lower',
};

const round1 = (v: number) => Math.round(v * 10) / 10;

function totalsOf(rows: Array<Omit<ExecTotals, 'noAi'>>): ExecTotals {
  const t = { production: 0, manual: 0, withAi: 0, noAi: 0, errors: 0, unread: 0 };
  for (const r of rows) {
    t.production += r.production;
    t.manual += r.manual;
    t.withAi += r.withAi;
    t.errors += r.errors;
    t.unread += r.unread;
  }
  t.noAi = Math.max(0, t.production - t.withAi - t.errors - t.unread);
  return t;
}

function wasteOf(t: Pick<ExecTotals, 'production' | 'withAi' | 'unread'>): number | null {
  const read = t.production - t.unread;
  return read > 0 ? round1((100 * (read - t.withAi)) / read) : null;
}

export function execMetricsOf(t: ExecTotals, avgDurationMs: number | null = null): ExecMetrics {
  const read = t.production - t.unread;
  return {
    avgDurationMs,
    production: t.production,
    withAi: t.withAi,
    wastePct: wasteOf(t),
    perAnswer: t.withAi > 0 ? round1(read / t.withAi) : null,
    manual: t.manual,
  };
}

export function buildExecDashboard(input: {
  days: string[];
  rows: ExecDayRow[];
  endings: ExecEndingRow[];
}): ExecDashboard {
  const byDay = new Map(input.rows.map((r) => [r.day, r]));
  const days: ExecDay[] = input.days.map((day) => {
    const r = byDay.get(day);
    const production = r?.production ?? 0;
    const withAi = r?.with_ai ?? 0;
    const errors = r?.errors ?? 0;
    const unread = r?.unread ?? 0;
    return {
      day,
      production,
      manual: r?.manual ?? 0,
      withAi,
      errors,
      unread,
      noAi: Math.max(0, production - withAi - errors - unread),
      durationMsSum: r?.duration_ms_sum ?? 0,
      durationN: r?.duration_n ?? 0,
    };
  });
  const durN = days.reduce((n, d) => n + d.durationN, 0);
  return {
    days,
    totals: totalsOf(days),
    avgDurationMs: durN > 0 ? Math.round(days.reduce((n, d) => n + d.durationMsSum, 0) / durN) : null,
    endings: input.endings.map((e) => ({
      workflow: e.workflow,
      clientName: e.client_name ?? 'Sin negocio asignado',
      lastNode: e.last_node,
      manual: e.manual,
      executions: e.executions,
      withAi: e.with_ai,
      errors: e.errors,
    })),
  };
}

export interface ExecComparison {
  status: ComparisonStatus;
  current: ExecMetrics;
  previous: ExecMetrics;
  changes: Record<ExecMetricKey, Change>;
  /** The periods have different lengths: volumes were compared as daily averages. */
  perDay: boolean;
}

/** Shares compare as they are; volumes per day when the two periods differ in length. */
export function compareExecutions(cur: ExecDashboard, prev: ExecDashboard, days: { current: number; previous: number }): ExecComparison {
  const c = execMetricsOf(cur.totals, cur.avgDurationMs);
  const p = execMetricsOf(prev.totals, prev.avgDurationMs);
  const perDay = days.current !== days.previous && days.current > 0 && days.previous > 0;
  const vol = (v: number, n: number) => (perDay ? v / n : v);
  // The comparison is only fair when the baseline was read: otherwise its waste is unknown.
  const status: ComparisonStatus =
    prev.totals.unread > 0 && prev.totals.unread >= prev.totals.production * 0.05
      ? { available: false, reason: 'el periodo de comparación tiene muchas ejecuciones sin leer (corre el backfill)' }
      : { available: true, reason: null };
  const volumes: ComparisonStatus = { available: true, reason: null };
  return {
    status,
    current: c,
    previous: p,
    perDay,
    changes: {
      production: changeOf(vol(c.production, days.current), vol(p.production, days.previous), volumes),
      withAi: changeOf(vol(c.withAi, days.current), vol(p.withAi, days.previous), status),
      wastePct: changeOf(c.wastePct, p.wastePct, status),
      perAnswer: changeOf(c.perAnswer, p.perAnswer, status),
      manual: changeOf(vol(c.manual, days.current), vol(p.manual, days.previous), volumes),
      avgDurationMs: changeOf(c.avgDurationMs, p.avgDurationMs, volumes),
    },
  };
}

/* ------------------------------------------------------------------ plan -- */

export interface PlanCycle {
  /** First instant of the current cycle (UTC midnight of the reset day). */
  start: Date;
  /** First instant of the next cycle. */
  end: Date;
}

const DAY_MS = 86_400_000;

/**
 * The plan cycle `now` falls in. n8n restarts the counter on the subscription day each month; a
 * missing reset day means calendar months. UTC days: the exact hour n8n uses is not published,
 * so the cycle edges are approximate by up to a day.
 */
export function planCycle(now: Date, resetDay: number | null): PlanCycle {
  const d = resetDay !== null && resetDay >= 1 && resetDay <= 28 ? resetDay : 1;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const startMonth = now.getUTCDate() >= d ? m : m - 1;
  return { start: new Date(Date.UTC(y, startMonth, d)), end: new Date(Date.UTC(y, startMonth + 1, d)) };
}

export interface PlanUsage {
  connectionId: string;
  connectionName: string;
  limit: number | null;
  resetDay: number | null;
  cycleStart: string;
  cycleEnd: string;
  used: number;
  /** Share of the plan used so far; null without a limit. */
  usedPct: number | null;
  /** Executions at the end of the cycle at the pace so far; null in the first hours of a cycle. */
  projected: number | null;
  projectedPct: number | null;
  daysLeft: number;
}

export function planUsageOf(p: {
  connectionId: string;
  connectionName: string;
  limit: number | null;
  resetDay: number | null;
  used: number;
  now: Date;
}): PlanUsage {
  const cycle = planCycle(p.now, p.resetDay);
  const elapsed = p.now.getTime() - cycle.start.getTime();
  const length = cycle.end.getTime() - cycle.start.getTime();
  // Under 12 hours the pace is noise: no projection rather than a wild one.
  const projected = elapsed >= DAY_MS / 2 ? Math.round((p.used * length) / elapsed) : null;
  const pct = (v: number | null) => (v === null || p.limit === null ? null : round1((100 * v) / p.limit));
  return {
    connectionId: p.connectionId,
    connectionName: p.connectionName,
    limit: p.limit,
    resetDay: p.resetDay,
    cycleStart: cycle.start.toISOString(),
    cycleEnd: cycle.end.toISOString(),
    used: p.used,
    usedPct: pct(p.used),
    projected,
    projectedPct: pct(projected),
    daysLeft: Math.max(0, Math.ceil((cycle.end.getTime() - p.now.getTime()) / DAY_MS)),
  };
}

/* ----------------------------------------------------- who uses it most -- */

/** At most this many series in a chart (the categorical palette); the rest fold into «Otros». */
export const USAGE_MAX_SERIES = 8;
export const OTHER_KEY = '__otros';

type Acc = Omit<ExecTotals, 'noAi' | 'manual'> & { key: string; name: string; chartColor: string | null; daily: number[] };

function accumulate(rows: ExecUsageRow[], days: string[]): Acc[] {
  const idx = new Map(days.map((d, i) => [d, i]));
  const by = new Map<string, Acc>();
  for (const r of rows) {
    let a = by.get(r.key);
    if (!a) {
      a = { key: r.key, name: r.name ?? 'Sin negocio asignado', chartColor: r.chart_color, production: 0, withAi: 0, errors: 0, unread: 0, daily: days.map(() => 0) };
      by.set(r.key, a);
    }
    a.production += r.production;
    a.withAi += r.with_ai;
    a.errors += r.errors;
    a.unread += r.unread;
    const i = idx.get(r.day);
    if (i !== undefined) a.daily[i] += r.production;
  }
  return [...by.values()].sort((x, y) => y.production - x.production || x.name.localeCompare(y.name, 'es'));
}

/**
 * Businesses or workflows ranked by production executions, with their daily series and the
 * change against the comparison period. Past USAGE_MAX_SERIES the smallest fold into «Otros» so
 * a chart never needs a 9th color.
 */
export function buildUsageBreakdown(input: {
  days: string[];
  rows: ExecUsageRow[];
  previousRows: ExecUsageRow[];
  periodDays: { current: number; previous: number };
}): UsageBreakdown {
  const all = accumulate(input.rows, input.days);
  const prev = new Map<string, number>();
  for (const r of input.previousRows) prev.set(r.key, (prev.get(r.key) ?? 0) + r.production);
  const total = all.reduce((n, a) => n + a.production, 0);
  const { current: cd, previous: pd } = input.periodDays;
  const perDay = cd !== pd && cd > 0 && pd > 0;
  const vol = (v: number, n: number) => (perDay ? v / n : v);
  const ok: ComparisonStatus = { available: true, reason: null };

  const kept = all.length > USAGE_MAX_SERIES ? all.slice(0, USAGE_MAX_SERIES - 1) : all;
  const rest = all.length > USAGE_MAX_SERIES ? all.slice(USAGE_MAX_SERIES - 1) : [];
  const groups: Array<{ acc: Acc; prev: number; isOther: boolean }> = kept.map((a) => ({ acc: a, prev: prev.get(a.key) ?? 0, isOther: false }));
  if (rest.length > 0) {
    const keptKeys = new Set(kept.map((a) => a.key));
    const other: Acc = { key: OTHER_KEY, name: `Otros (${rest.length})`, chartColor: null, production: 0, withAi: 0, errors: 0, unread: 0, daily: input.days.map(() => 0) };
    for (const a of rest) {
      other.production += a.production;
      other.withAi += a.withAi;
      other.errors += a.errors;
      other.unread += a.unread;
      a.daily.forEach((v, i) => (other.daily[i] += v));
    }
    let prevOther = 0;
    for (const [k, v] of prev) if (!keptKeys.has(k)) prevOther += v;
    groups.push({ acc: other, prev: prevOther, isOther: true });
  }

  return {
    total,
    entities: groups.map(({ acc, prev: p, isOther }) => {
      const t = totalsOf([{ production: acc.production, manual: 0, withAi: acc.withAi, errors: acc.errors, unread: acc.unread }]);
      return {
        ...t,
        key: acc.key,
        name: acc.name,
        chartColor: acc.chartColor,
        isOther,
        wastePct: wasteOf(t),
        sharePct: total > 0 ? round1((100 * acc.production) / total) : null,
        daily: acc.daily,
        change: changeOf(vol(acc.production, cd), vol(p, pd), ok),
      };
    }),
  };
}
