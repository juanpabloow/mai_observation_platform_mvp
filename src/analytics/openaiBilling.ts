/**
 * COSTOS DE IA — parsing OpenAI's organization Costs and Usage pages. PURE: no network, no DB.
 * Anything unexpected is skipped (never read as 0) so a schema change degrades visibly in the
 * sync counts instead of silently writing wrong money.
 *
 *   GET /v1/organization/costs                → { data: [{ start_time, results: [{ amount: { value, currency }, line_item, project_id }] }], has_more, next_page }
 *   GET /v1/organization/usage/completions    → { data: [{ start_time, results: [{ input_tokens, input_cached_tokens, output_tokens, num_model_requests, model, project_id }] }], has_more, next_page }
 */

export interface CostRow {
  day: string; // UTC day the bucket starts (YYYY-MM-DD)
  projectId: string;
  lineItem: string;
  amountUsd: number;
}

export interface UsageRow {
  day: string;
  projectId: string;
  model: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface Page<T> {
  rows: T[];
  skipped: number;
  nextPage: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const label = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 200) : '');

function utcDay(unixSeconds: unknown): string | null {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function pageOf(json: unknown): { buckets: unknown[]; nextPage: string | null } | null {
  const p = obj(json);
  if (!p || !Array.isArray(p.data)) return null;
  const next = p.has_more === true && typeof p.next_page === 'string' && p.next_page ? p.next_page : null;
  return { buckets: p.data, nextPage: next };
}

export function parseCostsPage(json: unknown): Page<CostRow> | null {
  const page = pageOf(json);
  if (!page) return null;
  const rows: CostRow[] = [];
  let skipped = 0;
  for (const b of page.buckets) {
    const bucket = obj(b);
    const day = utcDay(bucket?.start_time);
    if (!bucket || !day || !Array.isArray(bucket.results)) {
      skipped += 1;
      continue;
    }
    for (const r of bucket.results) {
      const res = obj(r);
      const amount = obj(res?.amount);
      const value = nonNeg(amount?.value);
      // Only US$ is understood; another currency is skipped rather than summed as dollars.
      if (!res || value === null || (amount?.currency !== undefined && amount.currency !== 'usd')) {
        skipped += 1;
        continue;
      }
      rows.push({ day, projectId: label(res.project_id), lineItem: label(res.line_item), amountUsd: value });
    }
  }
  return { rows, skipped, nextPage: page.nextPage };
}

export function parseUsagePage(json: unknown): Page<UsageRow> | null {
  const page = pageOf(json);
  if (!page) return null;
  const rows: UsageRow[] = [];
  let skipped = 0;
  for (const b of page.buckets) {
    const bucket = obj(b);
    const day = utcDay(bucket?.start_time);
    if (!bucket || !day || !Array.isArray(bucket.results)) {
      skipped += 1;
      continue;
    }
    for (const r of bucket.results) {
      const res = obj(r);
      const input = nonNeg(res?.input_tokens);
      const output = nonNeg(res?.output_tokens);
      const requests = nonNeg(res?.num_model_requests);
      if (!res || input === null || output === null || requests === null) {
        skipped += 1;
        continue;
      }
      rows.push({
        day,
        projectId: label(res.project_id),
        model: label(res.model),
        requests: Math.round(requests),
        inputTokens: Math.round(input),
        cachedInputTokens: Math.round(nonNeg(res.input_cached_tokens) ?? 0),
        outputTokens: Math.round(output),
      });
    }
  }
  return { rows, skipped, nextPage: page.nextPage };
}

/** Rows with the same key (pages can split a day) are summed, so the upsert key stays unique. */
export function mergeCostRows(rows: CostRow[]): CostRow[] {
  const m = new Map<string, CostRow>();
  for (const r of rows) {
    const k = `${r.day}\u0000${r.projectId}\u0000${r.lineItem}`;
    const prev = m.get(k);
    m.set(k, prev ? { ...prev, amountUsd: prev.amountUsd + r.amountUsd } : { ...r });
  }
  return [...m.values()];
}

export function mergeUsageRows(rows: UsageRow[]): UsageRow[] {
  const m = new Map<string, UsageRow>();
  for (const r of rows) {
    const k = `${r.day}\u0000${r.projectId}\u0000${r.model}`;
    const p = m.get(k);
    m.set(
      k,
      p
        ? {
            ...p,
            requests: p.requests + r.requests,
            inputTokens: p.inputTokens + r.inputTokens,
            cachedInputTokens: p.cachedInputTokens + r.cachedInputTokens,
            outputTokens: p.outputTokens + r.outputTokens,
          }
        : { ...r },
    );
  }
  return [...m.values()];
}

export interface ProjectRow {
  projectId: string;
  name: string | null;
  status: string | null;
}

/** GET /v1/organization/projects → { data: [{ id, name, status }], has_more, last_id }. */
export function parseProjectsPage(json: unknown): { rows: ProjectRow[]; after: string | null } | null {
  const p = obj(json);
  if (!p || !Array.isArray(p.data)) return null;
  const rows: ProjectRow[] = [];
  for (const item of p.data) {
    const it = obj(item);
    if (!it || typeof it.id !== 'string' || !it.id || it.id.length > 200) continue;
    rows.push({
      projectId: it.id,
      name: typeof it.name === 'string' && it.name.trim() ? it.name.slice(0, 200) : null,
      status: typeof it.status === 'string' ? it.status.slice(0, 40) : null,
    });
  }
  const after = p.has_more === true && typeof p.last_id === 'string' && p.last_id ? p.last_id : null;
  return { rows, after };
}

/** An OpenAI organization Admin key. Checked before any network call or storage. */
export function looksLikeAdminKey(key: string): boolean {
  return /^sk-admin-[A-Za-z0-9_-]{20,300}$/.test(key);
}
