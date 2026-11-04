import type { Period } from './valueDashboardModel.js';
import type { Baseline } from './aiCostPeriods.js';
import { METRIC_DIRECTION, type AiCostComparison, type AiCostDashboard, type Change, type DayCost, type MetricKey, type Money } from './aiCostModel.js';

/**
 * COSTOS DE IA — the downloadable report. Pure: same input, same bytes.
 *   - Markdown: readable by a person, and self-describing for an AI (definitions, caveats and
 *     the raw numbers as a JSON block at the end, so a model never has to parse tables).
 *   - CSV: one row per period × business × workflow × model, for a spreadsheet.
 * Business and workflow names are the agency's own configuration; no message content exists in
 * the source data, so none can leak here.
 */

export interface AiCostReportInput {
  period: Period;
  baseline: Baseline;
  tz: string;
  generatedAt: string;
  usdCop: number | null;
  /** Where the rate came from (today's TRM or the manual fallback). */
  fx?: { source: 'trm' | 'env'; validFrom: string | null; validTo: string | null } | null;
  /** Limited to one business (its owner's report); absent/null = every business. */
  client?: { id: string; name: string } | null;
  /** What OpenAI billed the organization (agency report only). */
  billing?: { connected: boolean; totalUsd: number | null; previousTotalUsd: number | null; lastSyncedAt: string | null } | null;
  current: AiCostDashboard;
  previous: AiCostDashboard;
  comparison: AiCostComparison;
}

export const METRIC_LABEL: Record<MetricKey, string> = {
  costUsd: 'Costo estimado (US$)',
  perConversationUsd: 'Costo por conversación (US$)',
  inputPerCall: 'Tokens de entrada por llamada',
  outputPerCall: 'Tokens de salida por llamada',
  callsPerExecution: 'Llamadas al modelo por ejecución',
  calls: 'Llamadas al modelo',
  executions: 'Ejecuciones con IA',
  conversations: 'Conversaciones con mensajes del cliente',
};

const BASELINE_LABEL: Record<Baseline['key'], (days: number) => string> = {
  anterior: (days) => `los ${days} días anteriores`,
  mes: () => 'las mismas fechas del mes anterior',
  custom: (days) => `periodo elegido, ${days} días`,
};

const MONEY_KEYS = new Set<MetricKey>(['costUsd', 'perConversationUsd']);

function num(v: number | null, digits = 0): string {
  if (v === null) return '—';
  return v.toLocaleString('es-CO', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function usdText(v: number | null): string {
  if (v === null) return '—';
  const digits = v !== 0 && Math.abs(v) < 1 ? 4 : 2;
  return `US$${v.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: digits })}`;
}

function moneyText(m: Money): string {
  if (m.usd === null) return m.partial ? 'sin precio' : '—';
  return m.partial ? `${usdText(m.usd)} + sin precio` : usdText(m.usd);
}

/** A day's money: «sin precio» when it had calls but nothing priced, «+ sin precio» when partial. */
export function dayMoneyText(d: Pick<DayCost, 'usd' | 'calls'> & { partial?: boolean }): string {
  if (d.usd === null) return d.calls > 0 ? 'sin precio' : '—';
  return d.partial ? `${usdText(d.usd)} + sin precio` : usdText(d.usd);
}

export function changeText(c: Change): string {
  if (c.kind === 'unavailable') return `sin comparación (${c.reason})`;
  if (c.kind === 'no_prev') return 'sin actividad en el periodo de comparación';
  if (c.pct === 0) return '= 0 %';
  const pct = Math.abs(c.pct).toLocaleString('es-CO', { maximumFractionDigits: 1 });
  return `${c.pct > 0 ? '▲' : '▼'} ${pct} %`;
}

/** «mejor» / «peor» for metrics where lower is better; nothing for volumes. */
export function verdictOf(key: MetricKey, c: Change): 'mejor' | 'peor' | null {
  if (METRIC_DIRECTION[key] !== 'lower' || c.kind !== 'pct' || c.pct === 0) return null;
  return c.pct < 0 ? 'mejor' : 'peor';
}

function metricValue(key: MetricKey, v: number | null): string {
  if (MONEY_KEYS.has(key)) return usdText(v);
  if (key === 'callsPerExecution') return num(v, 2);
  return num(v === null ? null : Math.round(v));
}

const row = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
const table = (head: string[], rows: string[][]) =>
  [row(head), row(head.map(() => '---')), ...rows.map(row)].join('\n');

export function fxText(fx: AiCostReportInput['fx']): string {
  if (!fx) return 'tasa manual';
  if (fx.source === 'env') return 'tasa manual';
  const range = fx.validFrom && fx.validTo && fx.validFrom !== fx.validTo ? `${fx.validFrom} a ${fx.validTo}` : fx.validFrom ?? '';
  return `TRM oficial${range ? ` vigente ${range}` : ''}, Superintendencia Financiera`;
}

export function reportFileStem(r: AiCostReportInput): string {
  const who = r.client ? `_${r.client.name.normalize('NFD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'negocio'}` : '';
  return `costos-ia${who}_${r.period.fromDay}_${r.period.toDay}`;
}

export function renderAiCostMarkdown(r: AiCostReportInput): string {
  const { current: cur, previous: prev, comparison: cmp, period: p, baseline: b } = r;
  const keys = Object.keys(METRIC_LABEL) as MetricKey[];
  const estimatePct = cur.totals.calls > 0 ? Math.round((100 * cur.totals.estimateCalls) / cur.totals.calls) : null;
  const out: string[] = [];

  out.push(`# Costos de IA${r.client ? ` — ${r.client.name}` : ''} — ${p.fromDay} a ${p.toDay}`);
  out.push('');
  out.push(`- Periodo: ${p.fromDay} a ${p.toDay} (${p.days} días, hora de ${r.tz}).`);
  out.push(`- Comparado con: ${b.fromDay} a ${b.toDay} (${BASELINE_LABEL[b.key](b.days)}).`);
  if (cmp.perDay) out.push('- Los periodos tienen distinta duración: costo, llamadas, ejecuciones y conversaciones se comparan como promedio por día.');
  out.push(`- Generado: ${r.generatedAt}.`);
  out.push(`- Tasa de cambio: ${r.usdCop === null ? 'no disponible (solo dólares)' : `${num(r.usdCop, 2)} COP por US$ (${fxText(r.fx)})`}.`);
  if (!cmp.status.available) out.push(`- **Sin comparación:** ${cmp.status.reason}.`);
  if (r.billing?.connected) {
    out.push(`- **Facturado por OpenAI** (toda la organización, días UTC): ${usdText(r.billing.totalUsd)} en el periodo; ${usdText(r.billing.previousTotalUsd)} en la comparación. Estimado por n8n: ${moneyText(cur.totals.cost)}. La diferencia es razonamiento, caché y usos fuera de n8n.`);
  }
  out.push('');
  out.push('## Cómo leer estas cifras');
  out.push('');
  out.push('- Son **estimaciones a precio de lista**, no la factura del proveedor.');
  out.push(`- ${estimatePct === null ? 'No hubo llamadas al modelo en el periodo.' : `${estimatePct} % de las llamadas trae solo la estimación que calcula n8n contando texto.`} Esa estimación no incluye los tokens de razonamiento (que el proveedor cobra como salida) ni separa los tokens en caché: el costo real puede ser mayor.`);
  out.push('- «—» o «sin precio» significa desconocido, nunca cero. Un modelo sin precio en la tabla cuenta sus tokens pero no su costo.');
  out.push('- Para saber si un cambio en el bot funcionó, mira las métricas por unidad (por llamada, por ejecución, por conversación): no dependen de cuánta gente escribió.');
  out.push('');
  out.push('## Resumen y comparación');
  out.push('');
  out.push(table(
    ['Métrica', 'Periodo actual', 'Periodo de comparación', 'Cambio', 'Lectura'],
    keys.map((k) => [
      METRIC_LABEL[k],
      // The total keeps its priced part visible («+ sin precio»); its change stays unavailable.
      k === 'costUsd' ? moneyText(cur.totals.cost) : metricValue(k, cmp.current[k]),
      k === 'costUsd' ? moneyText(prev.totals.cost) : metricValue(k, cmp.previous[k]),
      changeText(cmp.changes[k]), verdictOf(k, cmp.changes[k]) ?? '',
    ]),
  ));
  out.push('');
  out.push(`Tokens del periodo: ${num(cur.totals.inputTokens)} de entrada y ${num(cur.totals.outputTokens)} de salida (comparación: ${num(prev.totals.inputTokens)} y ${num(prev.totals.outputTokens)}).`);
  if (cur.coverage.withoutData > 0 || cur.coverage.unscanned > 0) {
    out.push('');
    out.push(`Cobertura: de ${num(cur.coverage.total)} ejecuciones de workflows con IA, ${num(cur.coverage.unscanned)} sin leer y ${num(cur.coverage.withoutData)} sin datos guardados en n8n (tokens desconocidos).`);
  }
  out.push('');
  out.push('## Por negocio');
  out.push('');
  out.push(cur.byClient.length === 0 ? 'Sin llamadas al modelo en el periodo.' : table(
    ['Negocio', 'Costo', 'Cambio de costo', 'Llamadas', 'Tokens entrada', 'Tokens salida', 'Conversaciones', 'Costo por conversación', 'Cambio por conversación', 'Citas del bot', 'Costo por cita'],
    cur.byClient.map((c) => {
      const ch = cmp.clients[c.clientId ?? ''];
      return [c.clientName, moneyText(c.cost), ch ? changeText(ch.costUsd) : '', num(c.calls), num(c.inputTokens), num(c.outputTokens),
        num(c.conversations), usdText(c.perConversationUsd), ch ? changeText(ch.perConversationUsd) : '', num(c.botAppointments), usdText(c.perAppointmentUsd)];
    }),
  ));
  out.push('');
  out.push('## Por workflow');
  out.push('');
  out.push(cur.byWorkflow.length === 0 ? 'Sin workflows con llamadas al modelo en el periodo.' : table(
    ['Workflow', 'Negocio', 'Modelo', 'Costo', 'Cambio de costo', 'Ejecuciones', 'Costo por ejecución', 'Tokens entrada por llamada', 'Cambio', 'Llamadas por ejecución', 'Cambio', 'Sin datos en n8n'],
    cur.byWorkflow.map((w) => {
      const ch = cmp.workflows[w.workflowId];
      return [w.workflowName, w.clientName, w.models.join(', '), moneyText(w.cost), ch ? changeText(ch.costUsd) : '',
        num(w.executions), usdText(w.perExecutionUsd), num(w.calls > 0 ? Math.round(w.inputTokens / w.calls) : null), ch ? changeText(ch.inputPerCall) : '',
        num(w.executions > 0 ? w.calls / w.executions : null, 2), ch ? changeText(ch.callsPerExecution) : '', num(w.coverage.withoutData)];
    }),
  ));
  out.push('');
  out.push('## Por modelo');
  out.push('');
  out.push(cur.byModel.length === 0 ? 'Sin llamadas al modelo en el periodo.' : table(
    ['Modelo', 'Origen del conteo', 'Llamadas', 'Tokens entrada', 'Tokens salida', 'Costo'],
    cur.byModel.map((m) => [m.model ?? 'desconocido', m.source === 'estimate' ? 'estimado por n8n' : 'proveedor',
      num(m.calls), num(m.inputTokens), num(m.outputTokens), moneyText(m.cost)]),
  ));
  out.push('');
  out.push('## Por día');
  out.push('');
  out.push(table(['Día', 'Llamadas', 'Tokens entrada', 'Tokens salida', 'Costo con precio'],
    cur.daily.map((d) => [d.day, num(d.calls), num(d.inputTokens), num(d.outputTokens), dayMoneyText(d)])));
  out.push('');
  out.push('## Reuniones (análisis con IA, conteo real del proveedor)');
  out.push('');
  out.push(cur.meetings.analyses === 0 ? 'Sin análisis de reuniones en el periodo.' :
    `${num(cur.meetings.analyses)} análisis · ${num(cur.meetings.inputTokens)} tokens de entrada · ${num(cur.meetings.outputTokens)} de salida · costo ${moneyText(cur.meetings.cost)}. No se suma al costo de los bots.`);
  out.push('');
  out.push('## Precios usados (US$ por millón de tokens)');
  out.push('');
  out.push(table(['Modelo', 'Entrada', 'Entrada en caché', 'Salida', 'Estado'],
    cur.prices.map((x) => [x.model, usdText(x.inPerM), x.cachedInPerM === null ? '—' : usdText(x.cachedInPerM), usdText(x.outPerM),
      x.verified ? `verificado ${x.checkedAt}` : `por verificar (${x.checkedAt})`])));
  out.push('');
  out.push('## Datos para análisis automático');
  out.push('');
  out.push('Los mismos números en JSON. `null` = desconocido (nunca cero). Importes en US$ estimados a precio de lista.');
  out.push('');
  out.push('```json');
  out.push(JSON.stringify({
    periodo: { desde: p.fromDay, hasta: p.toDay, dias: p.days, zona: r.tz },
    periodo_comparacion: { desde: b.fromDay, hasta: b.toDay, dias: b.days, tipo: b.key },
    totales_comparados_por_dia: cmp.perDay,
    comparacion_disponible: cmp.status.available,
    motivo_sin_comparacion: cmp.status.reason,
    usd_cop: r.usdCop,
    fuente_usd_cop: r.usdCop === null ? null : fxText(r.fx),
    negocio: r.client?.name ?? null,
    facturado_openai_usd: r.billing?.connected ? { periodo: r.billing.totalUsd, comparacion: r.billing.previousTotalUsd, sincronizado: r.billing.lastSyncedAt } : null,
    metricas: Object.fromEntries(keys.map((k) => [k, { actual: cmp.current[k], anterior: cmp.previous[k], cambio: cmp.changes[k], menor_es_mejor: METRIC_DIRECTION[k] === 'lower' }])),
    por_negocio: cur.byClient.map((c) => ({ negocio: c.clientName, costo_usd: c.cost.usd, costo_parcial: c.cost.partial, llamadas: c.calls, tokens_entrada: c.inputTokens, tokens_salida: c.outputTokens, conversaciones: c.conversations, costo_por_conversacion_usd: c.perConversationUsd, citas_bot: c.botAppointments, cambio: cmp.clients[c.clientId ?? ''] })),
    por_workflow: cur.byWorkflow.map((w) => ({ workflow: w.workflowName, workflow_id: w.workflowId, negocio: w.clientName, modelos: w.models, costo_usd: w.cost.usd, costo_parcial: w.cost.partial, ejecuciones: w.executions, llamadas: w.calls, tokens_entrada: w.inputTokens, tokens_salida: w.outputTokens, sin_datos_n8n: w.coverage.withoutData, cambio: cmp.workflows[w.workflowId] })),
    por_dia: cur.daily.map(({ byClient, unpricedTokensByClient: _unpriced, ...d }) => ({
      ...d,
      // Business names, not internal ids: the report is read by people and by an AI.
      por_negocio_usd: Object.fromEntries(Object.entries(byClient).map(([id, usd]) => [
        cur.byClient.find((c) => (c.clientId ?? '') === id)?.clientName ?? id, usd,
      ])),
    })),
    cobertura: cur.coverage,
    precios: cur.prices,
  }, null, 2));
  out.push('```');
  out.push('');
  return out.join('\n');
}

const csvCell = (v: string | number | null) => {
  if (v === null) return '';
  const s = String(v);
  // Quote always-risky cells; prefix formula starters so a spreadsheet never evaluates a name.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function renderAiCostCsv(r: AiCostReportInput): string {
  const lines = [[
    'periodo', 'desde', 'hasta', 'negocio', 'workflow', 'workflow_id', 'modelo', 'llamadas', 'ejecuciones',
    'tokens_entrada', 'tokens_salida', 'costo_usd', 'costo_parcial',
  ].join(',')];
  const add = (label: string, from: string, to: string, d: AiCostDashboard) => {
    for (const w of d.byWorkflow) {
      lines.push([label, from, to, w.clientName, w.workflowName, w.workflowId, w.models.join(' + '), w.calls, w.executions,
        w.inputTokens, w.outputTokens, w.cost.usd === null ? null : Number(w.cost.usd.toFixed(6)), w.cost.partial ? 'si' : 'no']
        .map(csvCell).join(','));
    }
  };
  add('actual', r.period.fromDay, r.period.toDay, r.current);
  add('comparacion', r.baseline.fromDay, r.baseline.toDay, r.previous);
  return lines.join('\n') + '\n';
}
