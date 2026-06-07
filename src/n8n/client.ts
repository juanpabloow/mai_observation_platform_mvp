import { logger } from '../logger.js';
import {
  n8nExecutionDetailSchema,
  n8nExecutionListResponseSchema,
  type N8nExecutionDetail,
  type N8nExecutionListResponse,
} from './types.js';

export interface N8nClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
}

export interface ListExecutionsParams {
  limit?: number;
  cursor?: string;
  status?: string;
}

export interface N8nClient {
  listExecutions(params?: ListExecutionsParams): Promise<N8nExecutionListResponse>;
  getExecution(id: string): Promise<N8nExecutionDetail>;
}

/** Thrown on any non-2xx (or transport-level) failure talking to n8n. */
export class N8nApiError extends Error {
  /** HTTP status, or 0 for transport/timeout errors. */
  readonly status: number;
  readonly bodySnippet: string;

  constructor(message: string, status: number, bodySnippet = '') {
    super(message);
    this.name = 'N8nApiError';
    this.status = status;
    this.bodySnippet = bodySnippet;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const BODY_SNIPPET_MAX = 500;

async function safeReadBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, BODY_SNIPPET_MAX);
  } catch {
    return '';
  }
}

/**
 * Create a typed client for a single n8n instance. This is the only module that
 * talks to n8n directly.
 */
export function createN8nClient(options: N8nClientOptions): N8nClient {
  // Normalise: strip any trailing slashes, then append the versioned API base.
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const apiBase = `${baseUrl}/api/v1`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get(path: string, searchParams?: URLSearchParams): Promise<unknown> {
    const qs = searchParams?.toString();
    const url = qs ? `${apiBase}${path}?${qs}` : `${apiBase}${path}`;

    // Log method + path only — never the API key (or full URL with query).
    logger.debug({ method: 'GET', path }, 'n8n request');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-N8N-API-KEY': options.apiKey,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new N8nApiError(`n8n request timed out after ${timeoutMs}ms (GET ${path})`, 0);
      }
      throw new N8nApiError(
        `n8n request failed (GET ${path}): ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const snippet = await safeReadBody(res);
      if (res.status === 401) {
        throw new N8nApiError('n8n auth failed — check API key', 401, snippet);
      }
      throw new N8nApiError(
        `n8n API error ${res.status} ${res.statusText} (GET ${path}): ${snippet}`,
        res.status,
        snippet,
      );
    }

    return res.json();
  }

  return {
    async listExecutions(params: ListExecutionsParams = {}): Promise<N8nExecutionListResponse> {
      const sp = new URLSearchParams();
      if (params.limit !== undefined) {
        sp.set('limit', String(params.limit));
      }
      if (params.cursor !== undefined) {
        sp.set('cursor', params.cursor);
      }
      if (params.status !== undefined) {
        sp.set('status', params.status);
      }
      // No includeData here: list responses are summaries only.
      const json = await get('/executions', sp);
      return n8nExecutionListResponseSchema.parse(json);
    },

    async getExecution(id: string): Promise<N8nExecutionDetail> {
      const sp = new URLSearchParams({ includeData: 'true' });
      const json = await get(`/executions/${encodeURIComponent(id)}`, sp);
      return n8nExecutionDetailSchema.parse(json);
    },
  };
}
