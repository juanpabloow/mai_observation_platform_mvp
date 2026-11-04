import {
  mergeCostRows,
  mergeUsageRows,
  parseCostsPage,
  parseProjectsPage,
  parseUsagePage,
  type CostRow,
  type ProjectRow,
  type Page,
  type UsageRow,
} from '../analytics/openaiBilling.js';

/**
 * COSTOS DE IA — read-only client for OpenAI's organization Costs and Usage endpoints.
 *
 * Safety: the host is FIXED (api.openai.com; nothing in the URL comes from a request), the key
 * travels only in the Authorization header and is never logged, redirects are refused, every call
 * has a timeout, and pagination is capped. Only GET endpoints are ever called.
 */

const BASE = 'https://api.openai.com/v1/organization';
const TIMEOUT_MS = 15_000;
const MAX_PAGES = 20;

/**
 * Error kinds, so a failure is handled by what OpenAI actually said:
 *   auth        401/403 — the key. Never retried.
 *   rate_limit  429 without a billing code: too many requests. Retried with backoff.
 *   quota       429 with a billing/spend/quota code (credit_balance_exhausted, …,
 *               type insufficient_quota). Retrying does not help: never retried.
 *   http        any other status. 5xx is retried, 4xx is not.
 *   network     no response (DNS, reset, timeout). Retried.
 *   format      not the JSON we expect. Never retried.
 */
export type OpenAiAdminErrorKind = 'auth' | 'rate_limit' | 'quota' | 'http' | 'network' | 'format';

export class OpenAiAdminError extends Error {
  constructor(
    message: string,
    readonly kind: OpenAiAdminErrorKind,
    readonly detail: { status?: number; code?: string; retryAfterMs?: number; attempts?: number } = {},
  ) {
    super(message);
  }

  get retryable(): boolean {
    if (this.kind === 'rate_limit' || this.kind === 'network') return true;
    return this.kind === 'http' && (this.detail.status ?? 0) >= 500;
  }
}

/**
 * Bounded retries for transient failures (OpenAI's guidance: honor Retry-After when present,
 * else exponential backoff with jitter, a limited number of times; failed requests still count
 * against the per-minute limit). A Retry-After longer than `maxDelayMs` is not waited out: the
 * sync fails now and the worker's next attempt (hours later) tries again.
 */
export interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
  /** [0, 1). Injected so tests are deterministic. */
  random: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  retries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 20_000,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/** Codes OpenAI documents for 429s that need someone to fix billing or limits. */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
]);

/** Retry-After in ms: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  // An HTTP-date always ends in GMT; anything else ("-1", "pronto") is unreadable, not "now".
  if (!/GMT$/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Only a short identifier from the error body: never its message, never anything echoed back. */
async function errorCodeOf(res: Response): Promise<{ code?: string; type?: string }> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; type?: unknown } } | null;
    const pick = (v: unknown) => (typeof v === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(v) ? v : undefined);
    return { code: pick(body?.error?.code), type: pick(body?.error?.type) };
  } catch {
    return {};
  }
}

async function errorOf(res: Response): Promise<OpenAiAdminError> {
  const status = res.status;
  if (status === 401 || status === 403) {
    return new OpenAiAdminError('OpenAI rechazó la clave: revisa que sea una Admin key vigente de la organización.', 'auth', { status });
  }
  const { code, type } = await errorCodeOf(res);
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after')) ?? undefined;
  if (status === 429) {
    if ((code && QUOTA_CODES.has(code)) || type === 'insufficient_quota') {
      return new OpenAiAdminError(
        `OpenAI respondió 429 por saldo, cuota o límite de gasto (${code ?? type}): reintentar no lo resuelve; revisa la facturación de la organización.`,
        'quota',
        { status, code: code ?? type },
      );
    }
    return new OpenAiAdminError('OpenAI respondió 429: demasiadas consultas seguidas. Se reintentará en la próxima sincronización.', 'rate_limit', {
      status,
      code,
      retryAfterMs,
    });
  }
  return new OpenAiAdminError(`OpenAI respondió ${status}.`, 'http', { status, code, retryAfterMs });
}

type Fetcher = typeof fetch;

async function getJsonOnce(url: URL, key: string, fetcher: Fetcher): Promise<unknown> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new OpenAiAdminError('No se pudo conectar con OpenAI.', 'network');
  }
  if (!res.ok) throw await errorOf(res);
  try {
    return await res.json();
  } catch {
    throw new OpenAiAdminError('OpenAI devolvió una respuesta que no es JSON.', 'format');
  }
}

/** Delay before retry number `n` (1-based): Retry-After if given, else exponential with jitter (half fixed, half random). */
export function retryDelayMs(err: OpenAiAdminError, n: number, policy: RetryPolicy): number {
  if (err.detail.retryAfterMs !== undefined) return err.detail.retryAfterMs;
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (n - 1));
  return Math.round(ceiling / 2 + (policy.random() * ceiling) / 2);
}

async function getJson(url: URL, key: string, fetcher: Fetcher, policy: RetryPolicy): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await getJsonOnce(url, key, fetcher);
    } catch (err) {
      if (!(err instanceof OpenAiAdminError)) throw err;
      err.detail.attempts = attempt;
      if (!err.retryable || attempt > policy.retries) throw err;
      const delay = retryDelayMs(err, attempt, policy);
      if (delay > policy.maxDelayMs) throw err;
      await policy.sleep(delay);
    }
  }
}

async function paginate<T>(
  path: string,
  params: Record<string, string | string[]>,
  parse: (json: unknown) => Page<T> | null,
  key: string,
  fetcher: Fetcher,
  policy: RetryPolicy,
): Promise<{ rows: T[]; skipped: number }> {
  const rows: T[] = [];
  let skipped = 0;
  let page: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
    }
    if (page) url.searchParams.set('page', page);
    const parsed = parse(await getJson(url, key, fetcher, policy));
    if (!parsed) throw new OpenAiAdminError('OpenAI devolvió un formato inesperado.', 'format');
    rows.push(...parsed.rows);
    skipped += parsed.skipped;
    if (!parsed.nextPage) return { rows, skipped };
    page = parsed.nextPage;
  }
  return { rows, skipped };
}

/** Daily costs in US$ per project × line item, for [startUnix, endUnix). */
export async function fetchCosts(key: string, startUnix: number, endUnix: number, fetcher: Fetcher = fetch, policy: RetryPolicy = DEFAULT_RETRY) {
  const r = await paginate<CostRow>(
    '/costs',
    { start_time: String(startUnix), end_time: String(endUnix), bucket_width: '1d', limit: '180', group_by: ['project_id', 'line_item'] },
    parseCostsPage,
    key,
    fetcher,
    policy,
  );
  return { rows: mergeCostRows(r.rows), skipped: r.skipped };
}

/** The organization's projects (active and archived), for picking them by name. */
export async function fetchProjects(key: string, fetcher: Fetcher = fetch, policy: RetryPolicy = DEFAULT_RETRY): Promise<ProjectRow[]> {
  const rows: ProjectRow[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(`${BASE}/projects`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('include_archived', 'true');
    if (after) url.searchParams.set('after', after);
    const parsed = parseProjectsPage(await getJson(url, key, fetcher, policy));
    if (!parsed) throw new OpenAiAdminError('OpenAI devolvió un formato inesperado.', 'format');
    rows.push(...parsed.rows);
    if (!parsed.after) break;
    after = parsed.after;
  }
  return rows;
}

/** Daily completions usage per project × model, for [startUnix, endUnix). */
export async function fetchCompletionsUsage(key: string, startUnix: number, endUnix: number, fetcher: Fetcher = fetch, policy: RetryPolicy = DEFAULT_RETRY) {
  const r = await paginate<UsageRow>(
    '/usage/completions',
    { start_time: String(startUnix), end_time: String(endUnix), bucket_width: '1d', limit: '31', group_by: ['project_id', 'model'] },
    parseUsagePage,
    key,
    fetcher,
    policy,
  );
  return { rows: mergeUsageRows(r.rows), skipped: r.skipped };
}
