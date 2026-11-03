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

export class OpenAiAdminError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'http' | 'network' | 'format',
  ) {
    super(message);
  }
}

type Fetcher = typeof fetch;

async function getJson(url: URL, key: string, fetcher: Fetcher): Promise<unknown> {
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
  if (res.status === 401 || res.status === 403) {
    throw new OpenAiAdminError('OpenAI rechazó la clave: revisa que sea una Admin key vigente de la organización.', 'auth');
  }
  if (!res.ok) throw new OpenAiAdminError(`OpenAI respondió ${res.status}.`, 'http');
  try {
    return await res.json();
  } catch {
    throw new OpenAiAdminError('OpenAI devolvió una respuesta que no es JSON.', 'format');
  }
}

async function paginate<T>(
  path: string,
  params: Record<string, string | string[]>,
  parse: (json: unknown) => Page<T> | null,
  key: string,
  fetcher: Fetcher,
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
    const parsed = parse(await getJson(url, key, fetcher));
    if (!parsed) throw new OpenAiAdminError('OpenAI devolvió un formato inesperado.', 'format');
    rows.push(...parsed.rows);
    skipped += parsed.skipped;
    if (!parsed.nextPage) return { rows, skipped };
    page = parsed.nextPage;
  }
  return { rows, skipped };
}

/** Daily costs in US$ per project × line item, for [startUnix, endUnix). */
export async function fetchCosts(key: string, startUnix: number, endUnix: number, fetcher: Fetcher = fetch) {
  const r = await paginate<CostRow>(
    '/costs',
    { start_time: String(startUnix), end_time: String(endUnix), bucket_width: '1d', limit: '180', group_by: ['project_id', 'line_item'] },
    parseCostsPage,
    key,
    fetcher,
  );
  return { rows: mergeCostRows(r.rows), skipped: r.skipped };
}

/** The organization's projects (active and archived), for picking them by name. */
export async function fetchProjects(key: string, fetcher: Fetcher = fetch): Promise<ProjectRow[]> {
  const rows: ProjectRow[] = [];
  let after: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const url = new URL(`${BASE}/projects`);
    url.searchParams.set('limit', '100');
    url.searchParams.set('include_archived', 'true');
    if (after) url.searchParams.set('after', after);
    const parsed = parseProjectsPage(await getJson(url, key, fetcher));
    if (!parsed) throw new OpenAiAdminError('OpenAI devolvió un formato inesperado.', 'format');
    rows.push(...parsed.rows);
    if (!parsed.after) break;
    after = parsed.after;
  }
  return rows;
}

/** Daily completions usage per project × model, for [startUnix, endUnix). */
export async function fetchCompletionsUsage(key: string, startUnix: number, endUnix: number, fetcher: Fetcher = fetch) {
  const r = await paginate<UsageRow>(
    '/usage/completions',
    { start_time: String(startUnix), end_time: String(endUnix), bucket_width: '1d', limit: '31', group_by: ['project_id', 'model'] },
    parseUsagePage,
    key,
    fetcher,
  );
  return { rows: mergeUsageRows(r.rows), skipped: r.skipped };
}
