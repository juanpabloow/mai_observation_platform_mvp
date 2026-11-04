import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { extractLlmUsage } from '../../src/analytics/llmUsage.js';
import { llmCostUsd, priceKeyFor } from '../../src/analytics/llmPricing.js';
import { buildAiCostDashboard, compareAiCosts } from '../../src/analytics/aiCostModel.js';
import { dayMoneyText, renderAiCostCsv, renderAiCostMarkdown, reportFileStem } from '../../src/analytics/aiCostReport.js';
import { baselineInputFrom, monthEarlier, resolveBaseline } from '../../src/analytics/aiCostPeriods.js';

/** One LangChain model sub-node run, shaped like the ingested n8n payloads (no real content). */
function lmRun(usage: Record<string, unknown>, model: string | null = 'gpt-5.6-terra') {
  return {
    startTime: 1,
    executionTime: 900,
    executionStatus: 'success',
    data: { ai_languageModel: [[{ json: { response: { generations: [[{ text: 'sintético' }]] }, ...usage } }]] },
    ...(model === null
      ? {}
      : { inputOverride: { ai_languageModel: [[{ json: { messages: ['sintético'], options: { model } } }]] } }),
  };
}

const payload = (runData: Record<string, unknown>) => ({ resultData: { runData } });

test('no runData means n8n kept no data — not zero usage', () => {
  for (const raw of [null, undefined, {}, { resultData: {} }, 'x']) {
    assert.deepEqual(extractLlmUsage(raw), { hasRunData: false, calls: 0, groups: [] });
  }
});

test('an execution without model nodes is read, with zero calls', () => {
  const r = extractLlmUsage(payload({ 'WhatsApp Trigger': [{ data: { main: [[{ json: { a: 1 } }]] } }] }));
  assert.deepEqual(r, { hasRunData: true, calls: 0, groups: [] });
});

test('estimates and provider counts are kept apart and summed per model', () => {
  const r = extractLlmUsage(payload({
    'OpenAI Chat Model': [
      lmRun({ tokenUsageEstimate: { promptTokens: 5625, completionTokens: 0, totalTokens: 5625 } }),
      lmRun({ tokenUsageEstimate: { promptTokens: 5946, completionTokens: 49, totalTokens: 5995 } }),
    ],
    'Anthropic Chat Model': [lmRun({ tokenUsage: { promptTokens: 100, completionTokens: 20 } }, 'claude-x')],
  }));
  assert.equal(r.calls, 3);
  const byModel = Object.fromEntries(r.groups.map((g) => [`${g.model}/${g.source}`, g]));
  assert.deepEqual(byModel['gpt-5.6-terra/estimate'], {
    model: 'gpt-5.6-terra', source: 'estimate', calls: 2, inputTokens: 11571, outputTokens: 49,
  });
  assert.deepEqual(byModel['claude-x/provider'], {
    model: 'claude-x', source: 'provider', calls: 1, inputTokens: 100, outputTokens: 20,
  });
});

test('a provider count wins over an estimate on the same item', () => {
  const r = extractLlmUsage(payload({
    M: [lmRun({ tokenUsage: { promptTokens: 10, completionTokens: 5 }, tokenUsageEstimate: { promptTokens: 99, completionTokens: 99 } })],
  }));
  assert.deepEqual(r.groups, [{ model: 'gpt-5.6-terra', source: 'provider', calls: 1, inputTokens: 10, outputTokens: 5 }]);
});

test('missing model stays null; malformed counts are skipped, never read as 0', () => {
  const r = extractLlmUsage(payload({
    M: [
      lmRun({ tokenUsageEstimate: { promptTokens: 7, completionTokens: 3 } }, null),
      lmRun({ tokenUsageEstimate: { promptTokens: 'mucho', completionTokens: 3 } }),
      lmRun({ tokenUsageEstimate: { promptTokens: -1, completionTokens: 3 } }),
      lmRun({ tokenUsage: null }),
    ],
  }));
  assert.equal(r.calls, 1);
  assert.deepEqual(r.groups, [{ model: null, source: 'estimate', calls: 1, inputTokens: 7, outputTokens: 3 }]);
});

test('pricing: closed list, unknown model is null (never free)', () => {
  assert.equal(priceKeyFor('gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(priceKeyFor('gpt-5.6-terra-2027-01-01'), null);
  assert.equal(priceKeyFor('toString'), null);
  assert.equal(priceKeyFor(null), null);
  assert.equal(llmCostUsd('modelo-inventado', 1_000_000, 0), null);
  assert.equal(llmCostUsd(null, 1, 1), null);
  // 1M input at $2 + 0.5M output at $12 = $8
  assert.equal(llmCostUsd('gpt-5.6-terra', 1_000_000, 500_000), 8);
});

const usageRow = (o: Partial<Parameters<typeof buildAiCostDashboard>[0]['usage'][number]>) => ({
  client_id: 'c1', client_name: 'Barbería', chart_color: null, n8n_workflow_id: 'wf1', workflow_name: 'Bot', model: 'gpt-5.6-terra',
  usage_source: 'estimate' as const, day: '2026-11-01', executions: 1, calls: 2, input_tokens: 1_000_000, output_tokens: 0, ...o,
});

test('dashboard: priced + unpriced = partial money, and partial ratios are not shown', () => {
  const d = buildAiCostDashboard({
    days: ['2026-11-01', '2026-11-02'],
    usage: [usageRow({}), usageRow({ model: 'sin-precio', input_tokens: 10, day: '2026-11-02' })],
    coverage: [{ n8n_workflow_id: 'wf1', total: 5, scanned: 4, without_data: 1 }],
    activity: [{ client_id: 'c1', conversations: 4, bot_appointments: 1 }],
    meetings: [],
  });
  assert.equal(d.totals.cost.usd, 2);
  assert.equal(d.totals.cost.partial, true);
  assert.equal(d.totals.estimateCalls, 4);
  assert.equal(d.byClient[0].conversations, 4);
  assert.equal(d.byClient[0].perConversationUsd, null);
  assert.deepEqual(d.daily.map((x) => x.usd), [2, null]);
  assert.deepEqual(d.daily.map((x) => x.byClient), [{ c1: 2 }, {}]); // the unpriced day adds nothing
  assert.deepEqual(d.coverage, { total: 5, scanned: 4, unscanned: 1, withoutData: 1 });
  assert.equal(d.meetings.cost.usd, null);
});

test('dashboard: fully priced client gets cost per conversation and per appointment', () => {
  const d = buildAiCostDashboard({
    days: ['2026-11-01'],
    usage: [usageRow({ output_tokens: 500_000 })],
    coverage: [],
    activity: [{ client_id: 'c1', conversations: 4, bot_appointments: 2 }],
    meetings: [{ client_id: 'c1', client_name: 'Barbería', model: 'gpt-4o-mini', analyses: 2, input_tokens: 5, output_tokens: 5, cost_usd: 0.5, unpriced: 0 }],
  });
  assert.equal(d.byClient[0].cost.usd, 8);
  assert.equal(d.byClient[0].perConversationUsd, 2);
  assert.equal(d.byClient[0].perAppointmentUsd, 4);
  assert.equal(d.byWorkflow[0].perExecutionUsd, 8);
  assert.deepEqual(d.meetings.cost, { usd: 0.5, partial: false });
});

test('comparison: lower-is-better ratios, unknown stays unknown, unread baseline blocks it', () => {
  const mk = (input: number, calls: number, executions: number, conversations: number) => buildAiCostDashboard({
    days: ['2026-11-01'],
    usage: [usageRow({ input_tokens: input, calls, executions })],
    coverage: [{ n8n_workflow_id: 'wf1', total: executions, scanned: executions, without_data: 0 }],
    activity: [{ client_id: 'c1', conversations, bot_appointments: 0 }],
    meetings: [],
  });
  const prev = mk(2_000_000, 200, 100, 50);
  const cur = mk(1_000_000, 200, 100, 50);
  const c = compareAiCosts(cur, prev);
  assert.equal(c.status.available, true);
  assert.deepEqual(c.changes.costUsd, { kind: 'pct', pct: -50 });
  assert.deepEqual(c.changes.inputPerCall, { kind: 'pct', pct: -50 });
  assert.deepEqual(c.changes.callsPerExecution, { kind: 'pct', pct: 0 });
  assert.deepEqual(c.workflows.wf1.inputPerCall, { kind: 'pct', pct: -50 });
  assert.deepEqual(c.clients.c1.perConversationUsd, { kind: 'pct', pct: -50 });

  const empty = buildAiCostDashboard({ days: ['2026-10-01'], usage: [], coverage: [], activity: [], meetings: [] });
  const fromNothing = compareAiCosts(cur, empty);
  assert.deepEqual(fromNothing.changes.costUsd, { kind: 'no_prev' });
  assert.equal(fromNothing.changes.inputPerCall.kind, 'unavailable'); // no previous calls: no ratio

  const unread = buildAiCostDashboard({ days: ['2026-10-01'], usage: [], coverage: [{ n8n_workflow_id: 'wf1', total: 5, scanned: 2, without_data: 0 }], activity: [], meetings: [] });
  const blocked = compareAiCosts(cur, unread);
  assert.equal(blocked.status.available, false);
  assert.equal(blocked.changes.costUsd.kind, 'unavailable');
});

test('report: markdown carries caveats, the comparison and a parseable JSON block; CSV is formula-safe', () => {
  const dash = (name: string) => buildAiCostDashboard({
    days: ['2026-11-01'],
    usage: [usageRow({ workflow_name: name })],
    coverage: [],
    activity: [{ client_id: 'c1', conversations: 4, bot_appointments: 1 }],
    meetings: [],
  });
  const current = dash('=HYPERLINK("x")');
  const previous = dash('Bot');
  const period = { key: '7' as const, fromDay: '2026-10-28', toDay: '2026-11-03', days: 7, prevFromDay: '2026-10-21', prevToDay: '2026-10-27', startUtc: '', endUtc: '', prevStartUtc: '' };
  const r = resolveBaseline(period, { key: 'anterior' }, 'America/Bogota');
  assert.ok(r.ok);
  const input = { period, baseline: r.baseline, tz: 'America/Bogota', generatedAt: '2026-11-03T20:00:00.000Z', usdCop: 3900, current, previous, comparison: compareAiCosts(current, previous) };

  const md = renderAiCostMarkdown(input);
  assert.match(md, /^# Costos de IA — 2026-10-28 a 2026-11-03/);
  assert.match(md, /estimaciones a precio de lista/);
  assert.match(md, /Comparado con: 2026-10-21 a 2026-10-27 \(los 7 días anteriores\)/);
  const json = JSON.parse(md.slice(md.indexOf('```json') + 7, md.lastIndexOf('```')));
  assert.equal(json.metricas.costUsd.actual, 2);
  assert.equal(json.metricas.costUsd.menor_es_mejor, true);
  assert.equal(json.usd_cop, 3900);
  assert.equal(reportFileStem(input), 'costos-ia_2026-10-28_2026-11-03');

  const csv = renderAiCostCsv(input).trim().split('\n');
  assert.equal(csv.length, 3);
  assert.ok(csv[1].startsWith('actual,2026-10-28,2026-11-03,Barbería,"\'=HYPERLINK(""x"")"'), csv[1]);
  assert.ok(csv[2].startsWith('comparacion,2026-10-21,2026-10-27,Barbería,Bot,'));
});

test('baseline presets: previous window, one month earlier (clamped), custom with guards', () => {
  const period = { key: '30' as const, fromDay: '2026-10-05', toDay: '2026-11-03', days: 30, prevFromDay: '2026-09-05', prevToDay: '2026-10-04', startUtc: '', endUtc: '', prevStartUtc: '' };
  const tz = 'America/Bogota';
  const prev = resolveBaseline(period, { key: 'anterior' }, tz);
  assert.ok(prev.ok);
  assert.deepEqual([prev.baseline.fromDay, prev.baseline.toDay, prev.baseline.days], ['2026-09-05', '2026-10-04', 30]);
  assert.equal(prev.baseline.startUtc, '2026-09-05T05:00:00.000Z'); // local midnight in Bogotá
  const month = resolveBaseline(period, { key: 'mes' }, tz);
  assert.ok(month.ok);
  assert.deepEqual([month.baseline.fromDay, month.baseline.toDay], ['2026-09-05', '2026-10-03']);
  assert.equal(monthEarlier('2026-03-31'), '2026-02-28');
  assert.equal(monthEarlier('2026-01-15'), '2025-12-15');
  const long = { ...period, fromDay: '2026-08-01', days: 95 };
  assert.equal(resolveBaseline(long, { key: 'mes' }, tz).ok, false); // a month back would overlap
  assert.equal(resolveBaseline(period, { key: 'custom', from: '2026-10-01', to: '2026-10-10' }, tz).ok, false); // overlaps
  assert.equal(resolveBaseline(period, { key: 'custom', from: '2026-09-10', to: '2026-09-01' }, tz).ok, false);
  const custom = resolveBaseline(period, { key: 'custom', from: '2026-09-01', to: '2026-09-14' }, tz);
  assert.ok(custom.ok);
  assert.equal(custom.baseline.days, 14);
  assert.deepEqual(baselineInputFrom({ comparar: 'mes' }), { key: 'mes' });
  assert.deepEqual(baselineInputFrom({ comparar: 'raro' }), { key: 'anterior' });
});

test('comparison of periods with different lengths uses daily averages for totals only', () => {
  const mk = (cost1M: number, calls: number) => buildAiCostDashboard({
    days: ['2026-11-01'],
    usage: [usageRow({ input_tokens: cost1M, calls, executions: calls })],
    coverage: [],
    activity: [],
    meetings: [],
  });
  // 14 days costing $2 vs 28 days costing $4: same daily spend, same tokens per call.
  const c = compareAiCosts(mk(1_000_000, 10), mk(2_000_000, 20), { current: 14, previous: 28 });
  assert.equal(c.perDay, true);
  assert.deepEqual(c.changes.costUsd, { kind: 'pct', pct: 0 });
  assert.deepEqual(c.changes.calls, { kind: 'pct', pct: 0 });
  assert.deepEqual(c.changes.inputPerCall, { kind: 'pct', pct: 0 });
});

/* ---------------------------------------------- tarifas, alias y estados (2026-11-04) -- */

test('pricing: gpt-5.6-luna has its own verified rate, not terra\'s; a dated id is not guessed', () => {
  assert.equal(priceKeyFor('gpt-5.6-luna'), 'gpt-5.6-luna');
  // 1M input at $0.20 + 1M output at $1.20 (developers.openai.com/api/docs/pricing, Standard, short context)
  assert.equal(llmCostUsd('gpt-5.6-luna', 1_000_000, 1_000_000), 1.4);
  assert.notEqual(llmCostUsd('gpt-5.6-luna', 1_000_000, 0), llmCostUsd('gpt-5.6-terra', 1_000_000, 0));
  for (const id of ['gpt-5.6-luna-2026-10-25', 'GPT-5.6-LUNA', 'gpt-5.6', 'luna']) {
    assert.equal(priceKeyFor(id), null, `${id} must stay «sin precio» until it is listed`);
    assert.equal(llmCostUsd(id, 1_000_000, 0), null);
  }
});

test('pricing: an explicit alias resolves to its target; an alias to an unlisted target is null', () => {
  const prices = { 'modelo-a': { inPerM: 1, cachedInPerM: null, outPerM: 2, checkedAt: '2026-11-04', verified: true } };
  const aliases = { 'modelo-a-2026-10-01': 'modelo-a', 'modelo-b-2026-10-01': 'modelo-b' };
  assert.equal(priceKeyFor('modelo-a-2026-10-01', prices, aliases), 'modelo-a');
  assert.equal(priceKeyFor('modelo-b-2026-10-01', prices, aliases), null);
  assert.equal(priceKeyFor('modelo-a-2026-10-02', prices, aliases), null, 'no prefix matching');
  assert.equal(priceKeyFor('hasOwnProperty', prices, aliases), null);
});

test('dashboard: four states — no activity, activity without a price, partial, priced', () => {
  const build = (usage: ReturnType<typeof usageRow>[]) =>
    buildAiCostDashboard({ days: ['2026-11-01', '2026-11-02'], usage, coverage: [], activity: [], meetings: [] });

  const none = build([]);
  assert.equal(none.state, 'no_activity');
  assert.equal(none.totals.cost.usd, null, 'no activity is not US$0 of spend either');
  assert.deepEqual(none.unpricedModels, []);

  const unpriced = build([usageRow({ model: 'modelo-sin-tarifa', calls: 7 })]);
  assert.equal(unpriced.state, 'unpriced');
  assert.equal(unpriced.totals.cost.usd, null, 'never converted to 0');
  assert.deepEqual(unpriced.daily.map((d) => [d.usd, d.partial, d.calls]), [[null, true, 7], [null, false, 0]]);
  assert.deepEqual(unpriced.unpricedModels, [{ model: 'modelo-sin-tarifa', calls: 7, inputTokens: 1_000_000, outputTokens: 0 }]);

  const partial = build([usageRow({}), usageRow({ model: 'modelo-sin-tarifa', calls: 3 })]);
  assert.equal(partial.state, 'partial');
  assert.equal(partial.totals.cost.usd, 2);
  assert.equal(partial.daily[0].usd, 2);
  assert.equal(partial.daily[0].partial, true, 'the same day mixes priced and unpriced calls');
  assert.deepEqual(partial.daily[0].unpricedTokensByClient, { c1: 1_000_000 });

  const priced = build([usageRow({}), usageRow({ model: 'gpt-5.6-luna', day: '2026-11-02' })]);
  assert.equal(priced.state, 'priced');
  assert.deepEqual(priced.daily.map((d) => d.partial), [false, false]);
  assert.ok(Math.abs((priced.totals.cost.usd ?? 0) - 2.2) < 1e-9, 'terra $2 + luna $0.20 for 1M input each');
});

test('history: a model switch on 25 Oct is priced at read time once the model is listed — no stored amounts', () => {
  // Synthetic copy of the observed pattern: terra until 24 Oct, luna from 25 Oct. The usage rows
  // hold tokens only, so the same rows price differently as soon as the catalog has the model.
  const days = ['2026-10-24', '2026-10-25', '2026-10-26'];
  const usage = [
    usageRow({ day: '2026-10-24', model: 'gpt-5.6-terra', calls: 90, input_tokens: 500_000, output_tokens: 10_000 }),
    usageRow({ day: '2026-10-25', model: 'gpt-5.6-luna', calls: 101, input_tokens: 600_000, output_tokens: 12_000 }),
    usageRow({ day: '2026-10-26', model: 'gpt-5.6-luna', calls: 78, input_tokens: 450_000, output_tokens: 9_000 }),
    // A day where an unlisted id appears next to luna stays partial, not complete.
    usageRow({ day: '2026-10-26', model: 'gpt-5.6-luna-2026-10-25', calls: 2, input_tokens: 10_000, output_tokens: 100 }),
  ];
  const d = buildAiCostDashboard({ days, usage, coverage: [], activity: [], meetings: [] });
  const [oct24, oct25, oct26] = d.daily;
  assert.ok(Math.abs((oct24.usd ?? 0) - (0.5 * 2 + 0.01 * 12)) < 1e-9);
  assert.ok(Math.abs((oct25.usd ?? 0) - (0.6 * 0.2 + 0.012 * 1.2)) < 1e-9);
  assert.equal(oct25.partial, false);
  assert.ok(Math.abs((oct26.usd ?? 0) - (0.45 * 0.2 + 0.009 * 1.2)) < 1e-9);
  assert.equal(oct26.partial, true);
  assert.equal(d.state, 'partial');
  assert.deepEqual(d.unpricedModels.map((m) => m.model), ['gpt-5.6-luna-2026-10-25']);
  assert.equal(d.byModel.find((m) => m.model === 'gpt-5.6-luna')?.price?.key, 'gpt-5.6-luna');
  assert.ok(d.prices.some((p) => p.model === 'gpt-5.6-luna' && p.verified), '«Precios usados» lists it');
});

test('report: a day is «sin precio», «US$X + sin precio» or «—», never US$0 for unknown', () => {
  assert.equal(dayMoneyText({ usd: null, calls: 0 }), '—');
  assert.equal(dayMoneyText({ usd: null, calls: 5 }), 'sin precio');
  assert.equal(dayMoneyText({ usd: 1.5, calls: 5, partial: true }), 'US$1,50 + sin precio');
  assert.equal(dayMoneyText({ usd: 1.5, calls: 5, partial: false }), 'US$1,50');
});
