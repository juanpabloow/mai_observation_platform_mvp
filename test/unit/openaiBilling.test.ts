import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { looksLikeAdminKey, mergeCostRows, parseCostsPage, parseUsagePage } from '../../src/analytics/openaiBilling.js';
import { fetchCompletionsUsage, fetchCosts, OpenAiAdminError, parseRetryAfter, retryDelayMs, type RetryPolicy } from '../../src/openai/adminClient.js';

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

/* -------------------------------------------------- 429 y reintentos (2026-11-04) -- */

/** A fake OpenAI that answers from a script, one response per request, and records the sleeps. */
function scripted(responses: Array<() => Response>) {
  let i = 0;
  const fetcher = (async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return next();
  }) as typeof fetch;
  const sleeps: number[] = [];
  const policy: RetryPolicy = { retries: 3, baseDelayMs: 1_000, maxDelayMs: 20_000, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 };
  return { fetcher, policy, sleeps, calls: () => i };
}
const ok = () => new Response(JSON.stringify(costsPage([{ amount: { value: 1, currency: 'usd' }, line_item: 'a' }])), { status: 200 });
const tooMany = (headers: Record<string, string> = {}, error: Record<string, unknown> = { type: 'rate_limit_error', code: null, message: 'Rate limit reached for org-sintética' }) => () =>
  new Response(JSON.stringify({ error }), { status: 429, headers });

test('429 rate limit: honors Retry-After, then succeeds', async () => {
  const s = scripted([tooMany({ 'retry-after': '2' }), ok]);
  const r = await fetchCosts('sk-admin-test', DAY1, DAY2, s.fetcher, s.policy);
  assert.equal(r.rows.length, 1);
  assert.equal(s.calls(), 2);
  assert.deepEqual(s.sleeps, [2_000]);
});

test('429 rate limit without Retry-After: bounded exponential backoff with jitter, then gives up', async () => {
  const s = scripted([tooMany()]);
  await assert.rejects(fetchCosts('sk-admin-test', DAY1, DAY2, s.fetcher, s.policy), (e: unknown) => {
    assert.ok(e instanceof OpenAiAdminError);
    assert.equal(e.kind, 'rate_limit');
    assert.equal(e.detail.status, 429);
    assert.equal(e.detail.attempts, 4);
    assert.match(e.message, /429/);
    assert.ok(!e.message.includes('org-sintética'), 'the body message is never echoed');
    return true;
  });
  assert.equal(s.calls(), 4, '1 attempt + 3 retries, not forever');
  assert.deepEqual(s.sleeps, [750, 1_500, 3_000], 'half fixed + half random of 1s, 2s, 4s (random = 0.5)');
});

test('429 for quota, credit or spend limit: not retried, and said so', async () => {
  for (const error of [
    { type: 'insufficient_quota', code: 'insufficient_quota' },
    { type: 'insufficient_quota', code: 'credit_balance_exhausted' },
    { type: 'requests', code: 'organization_spend_limit_exceeded' },
    { type: 'insufficient_quota', code: 'algo_nuevo' },
  ]) {
    const s = scripted([tooMany({ 'retry-after': '1' }, error)]);
    await assert.rejects(fetchCosts('sk-admin-test', DAY1, DAY2, s.fetcher, s.policy), (e: unknown) => {
      assert.ok(e instanceof OpenAiAdminError);
      assert.equal(e.kind, 'quota', JSON.stringify(error));
      assert.match(e.message, /saldo, cuota o límite de gasto/);
      return true;
    });
    assert.equal(s.calls(), 1, `${error.code}: retrying a billing error does not restore access`);
    assert.deepEqual(s.sleeps, []);
  }
});

test('a Retry-After longer than the cap is not waited out: fail now, the worker retries later', async () => {
  const s = scripted([tooMany({ 'retry-after': '120' }), ok]);
  await assert.rejects(fetchCosts('sk-admin-test', DAY1, DAY2, s.fetcher, s.policy), (e: unknown) => e instanceof OpenAiAdminError && e.kind === 'rate_limit' && e.detail.retryAfterMs === 120_000);
  assert.equal(s.calls(), 1);
  assert.deepEqual(s.sleeps, []);
});

test('5xx and network errors are retried; 4xx, auth and format are not', async () => {
  const s5 = scripted([() => new Response('{}', { status: 503 }), ok]);
  assert.equal((await fetchCosts('sk-admin-test', DAY1, DAY2, s5.fetcher, s5.policy)).rows.length, 1);
  assert.equal(s5.calls(), 2);

  let n = 0;
  const flaky = (async () => {
    n += 1;
    if (n === 1) throw new TypeError('fetch failed');
    return ok();
  }) as typeof fetch;
  const sn = scripted([ok]);
  assert.equal((await fetchCosts('sk-admin-test', DAY1, DAY2, flaky, sn.policy)).rows.length, 1);
  assert.equal(n, 2);

  for (const [res, kind] of [[() => new Response('{}', { status: 400 }), 'http'], [() => new Response('{}', { status: 401 }), 'auth'], [() => new Response('nope', { status: 200 }), 'format']] as const) {
    const s = scripted([res, ok]);
    await assert.rejects(fetchCosts('sk-admin-test', DAY1, DAY2, s.fetcher, s.policy), (e: unknown) => e instanceof OpenAiAdminError && e.kind === kind);
    assert.equal(s.calls(), 1, `${kind} is not retried`);
  }
});

test('a 429 on page 2 retries that page only, keeping page 1', async () => {
  const pages: string[] = [];
  let failed = false;
  const fetcher = (async (input: URL | RequestInfo) => {
    const url = String(input);
    pages.push(url.includes('page=cur_2') ? '2' : '1');
    if (url.includes('page=cur_2') && !failed) {
      failed = true;
      return tooMany({ 'retry-after': '1' })();
    }
    return new Response(JSON.stringify(url.includes('page=cur_2')
      ? costsPage([{ amount: { value: 2, currency: 'usd' }, line_item: 'b' }])
      : costsPage([{ amount: { value: 1, currency: 'usd' }, line_item: 'a' }], { has_more: true, next_page: 'cur_2' })), { status: 200 });
  }) as typeof fetch;
  const r = await fetchCosts('sk-admin-test', DAY1, DAY2, fetcher, scripted([ok]).policy);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(pages, ['1', '2', '2']);
});

test('Retry-After parsing and backoff delays', () => {
  const now = Date.parse('2026-11-04T12:00:00Z');
  assert.equal(parseRetryAfter('3', now), 3_000);
  assert.equal(parseRetryAfter('0.5', now), 500);
  assert.equal(parseRetryAfter('Wed, 04 Nov 2026 12:00:10 GMT', now), 10_000);
  assert.equal(parseRetryAfter('Wed, 04 Nov 2026 11:00:00 GMT', now), 0);
  for (const bad of [null, '', 'pronto', '-1']) assert.equal(parseRetryAfter(bad, now), null);
  const policy: RetryPolicy = { retries: 5, baseDelayMs: 1_000, maxDelayMs: 8_000, sleep: async () => {}, random: () => 0.999 };
  const e = new OpenAiAdminError('x', 'rate_limit', { status: 429 });
  assert.deepEqual([1, 2, 3, 4, 5].map((k) => retryDelayMs(e, k, policy)), [1_000, 1_999, 3_998, 7_996, 7_996], 'capped at maxDelayMs');
});
