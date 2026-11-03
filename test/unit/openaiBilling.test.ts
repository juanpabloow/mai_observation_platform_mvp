import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { looksLikeAdminKey, mergeCostRows, parseCostsPage, parseUsagePage } from '../../src/analytics/openaiBilling.js';
import { fetchCompletionsUsage, fetchCosts, OpenAiAdminError } from '../../src/openai/adminClient.js';

const DAY1 = Date.UTC(2026, 9, 20) / 1000; // 2026-10-20 00:00 UTC
const DAY2 = DAY1 + 86_400;

const costsPage = (results: unknown[], extra: Record<string, unknown> = {}) => ({
  object: 'page',
  data: [{ object: 'bucket', start_time: DAY1, end_time: DAY2, results }],
  has_more: false,
  next_page: null,
  ...extra,
});

test('costs page: US$ rows per day × project × line item; odd rows skipped, never zeroed', () => {
  const p = parseCostsPage(
    costsPage([
      { object: 'organization.costs.result', amount: { value: 1.25, currency: 'usd' }, line_item: 'gpt-5.6-terra, input', project_id: 'proj_a' },
      { amount: { value: 0.5, currency: 'usd' }, line_item: null, project_id: null },
      { amount: { value: 9, currency: 'eur' } },
      { amount: { value: -1, currency: 'usd' } },
      { amount: 'x' },
    ]),
  );
  assert.ok(p);
  assert.deepEqual(p.rows, [
    { day: '2026-10-20', projectId: 'proj_a', lineItem: 'gpt-5.6-terra, input', amountUsd: 1.25 },
    { day: '2026-10-20', projectId: '', lineItem: '', amountUsd: 0.5 },
  ]);
  assert.equal(p.skipped, 3);
  assert.equal(parseCostsPage({ nope: true }), null);
  assert.equal(parseCostsPage(costsPage([], { has_more: true, next_page: 'cur_2' }))?.nextPage, 'cur_2');
});

test('usage page: provider token counts per model; merge sums split rows', () => {
  const p = parseUsagePage({
    object: 'page',
    data: [{ start_time: DAY1, results: [{ input_tokens: 1000, input_cached_tokens: 400, output_tokens: 500, num_model_requests: 5, model: 'gpt-5.6-terra', project_id: null }] }],
    has_more: false,
  });
  assert.deepEqual(p?.rows, [
    { day: '2026-10-20', projectId: '', model: 'gpt-5.6-terra', requests: 5, inputTokens: 1000, cachedInputTokens: 400, outputTokens: 500 },
  ]);
  const merged = mergeCostRows([
    { day: '2026-10-20', projectId: '', lineItem: 'x', amountUsd: 1 },
    { day: '2026-10-20', projectId: '', lineItem: 'x', amountUsd: 2 },
  ]);
  assert.deepEqual(merged, [{ day: '2026-10-20', projectId: '', lineItem: 'x', amountUsd: 3 }]);
});

test('admin key shape', () => {
  assert.ok(looksLikeAdminKey('sk-admin-' + 'a'.repeat(40)));
  for (const k of ['sk-proj-' + 'a'.repeat(40), 'sk-admin-short', '', 'sk-admin-' + 'a'.repeat(40) + ' x']) assert.ok(!looksLikeAdminKey(k), k);
});

test('client: fixed host, bearer header only, repeated group_by, follows pages, maps 401', async () => {
  const calls: Array<{ url: string; auth: string | null; redirect: string | undefined }> = [];
  const fetcher = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
    const second = url.includes('page=cur_2');
    const body = second
      ? costsPage([{ amount: { value: 2, currency: 'usd' }, line_item: 'b' }])
      : costsPage([{ amount: { value: 1, currency: 'usd' }, line_item: 'a' }], { has_more: true, next_page: 'cur_2' });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const r = await fetchCosts('sk-admin-test', DAY1, DAY2, fetcher);
  assert.equal(r.rows.length, 2);
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.ok(c.url.startsWith('https://api.openai.com/v1/organization/costs?'));
    assert.equal(c.auth, 'Bearer sk-admin-test');
    assert.equal(c.redirect, 'error');
    assert.ok(!c.url.includes('sk-admin'), 'the key never goes in the URL');
  }
  assert.match(calls[0].url, /group_by=project_id&group_by=line_item/);

  const denied = (async () => new Response('{}', { status: 401 })) as typeof fetch;
  await assert.rejects(fetchCompletionsUsage('sk-admin-test', DAY1, DAY2, denied), (e: unknown) => e instanceof OpenAiAdminError && e.kind === 'auth');
  const broken = (async () => new Response('not json', { status: 200 })) as typeof fetch;
  await assert.rejects(fetchCosts('sk-admin-test', DAY1, DAY2, broken), (e: unknown) => e instanceof OpenAiAdminError && e.kind === 'format');
});
