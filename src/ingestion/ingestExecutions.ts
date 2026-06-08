import { decrypt } from '../crypto.js';
import { logger } from '../logger.js';
import { createN8nClient, type N8nClient } from '../n8n/client.js';
import type { N8nExecutionDetail, N8nExecutionSummary } from '../n8n/types.js';
import { upsertMany, type NewExecution } from '../db/repositories/executions.js';
import {
  getIngestionState,
  recordFailedPoll,
  recordSuccessfulPoll,
} from '../db/repositories/ingestionState.js';
import type { N8nConnectionRow } from '../db/types.js';

/** Max concurrent getExecution detail fetches. */
export const CONCURRENCY = 10;

/** Page size when listing executions (newest first). */
const PAGE_LIMIT = 100;

export interface IngestResult {
  /** Full execution payloads successfully fetched this run. */
  fetched: number;
  /** Rows newly inserted (excludes ON CONFLICT DO NOTHING duplicates). */
  new: number;
  /** Per-execution detail-fetch failures (skipped, not fatal). */
  errors: number;
  /** Cursor we persisted: max numeric id seen, as a string (null if none yet). */
  newCursor: string | null;
}

/** Map a full n8n execution detail into an `executions` row. */
function mapDetailToRow(
  tenantId: string,
  connectionId: string,
  detail: N8nExecutionDetail,
): NewExecution {
  const { startedAt, stoppedAt } = detail;

  let durationMs: number | null = null;
  if (stoppedAt) {
    const start = Date.parse(startedAt);
    const stop = Date.parse(stoppedAt);
    if (!Number.isNaN(start) && !Number.isNaN(stop)) {
      durationMs = stop - start;
    }
  }

  return {
    tenant_id: tenantId,
    n8n_connection_id: connectionId,
    n8n_execution_id: detail.id,
    n8n_workflow_id: detail.workflowId,
    workflow_name: detail.workflowData?.name ?? null,
    status: detail.status,
    mode: detail.mode,
    started_at: startedAt,
    stopped_at: stoppedAt ?? null,
    duration_ms: durationMs,
    raw_data: detail.data ?? null, // stored as-is; never parsed here
  };
}

/** Fetch one execution's full payload; returns null (and logs) on failure. */
async function fetchRow(
  n8n: N8nClient,
  tenantId: string,
  connectionId: string,
  summary: N8nExecutionSummary,
): Promise<NewExecution | null> {
  try {
    const detail = await n8n.getExecution(summary.id);
    return mapDetailToRow(tenantId, connectionId, detail);
  } catch (err) {
    logger.warn(
      { err, connectionId, executionId: summary.id },
      'failed to fetch execution detail; skipping',
    );
    return null;
  }
}

/**
 * Ingest NEW executions for a single n8n connection: list what's new since the
 * stored cursor, fetch full payloads with bounded concurrency, upsert them
 * (stamped with tenant_id + n8n_connection_id), and update the cursor/health.
 * Does not loop and does not crash on a fetch failure — it records the failure
 * and returns a failure-shaped result.
 */
export async function ingestExecutionsForConnection(
  connection: N8nConnectionRow,
): Promise<IngestResult> {
  const tenantId = connection.tenant_id;
  const connectionId = connection.id;

  const apiKey = decrypt(connection.n8n_api_key_encrypted);
  const n8n = createN8nClient({ baseUrl: connection.n8n_base_url, apiKey });

  const state = await getIngestionState(connectionId);
  const prevLastSeen = state?.last_seen_execution_id ?? null;
  const prevLastSeenNum = prevLastSeen !== null ? Number(prevLastSeen) : null;
  const firstRun = prevLastSeenNum === null;

  // --- 1. Discover new execution summaries (newest first). ---
  const newSummaries: N8nExecutionSummary[] = [];
  let pages = 0;

  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await n8n.listExecutions({ limit: PAGE_LIMIT, cursor });
      pages += 1;

      let reachedSeen = false;
      for (const summary of page.data) {
        const idNum = Number(summary.id);
        if (prevLastSeenNum !== null && idNum <= prevLastSeenNum) {
          // Newest-first ⇒ everything beyond here is already ingested.
          reachedSeen = true;
          break;
        }
        newSummaries.push(summary);
      }

      if (firstRun) break; // first run: only the most recent page, not all history
      if (reachedSeen) break;
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
  } catch (err) {
    // Total fetch failure: record it, do NOT advance the cursor, don't crash.
    const message = err instanceof Error ? err.message : String(err);
    await recordFailedPoll(connectionId, tenantId, message);
    logger.error(
      { err, connection: connection.name, connectionId, pages },
      'ingestion failed while listing executions',
    );
    return { fetched: 0, new: 0, errors: 1, newCursor: prevLastSeen };
  }

  // --- 2. Fetch full payloads with bounded concurrency. ---
  const rows: NewExecution[] = [];
  let errors = 0;
  let batches = 0;

  for (let i = 0; i < newSummaries.length; i += CONCURRENCY) {
    const chunk = newSummaries.slice(i, i + CONCURRENCY);
    batches += 1;
    const settled = await Promise.all(
      chunk.map((s) => fetchRow(n8n, tenantId, connectionId, s)),
    );
    for (const row of settled) {
      if (row) {
        rows.push(row);
      } else {
        errors += 1;
      }
    }
  }

  // --- 3. Persist rows (idempotent) and advance the cursor. ---
  const newCount = await upsertMany(rows);

  const maxSeenNum = newSummaries.reduce<number>(
    (max, s) => Math.max(max, Number(s.id)),
    prevLastSeenNum ?? Number.NEGATIVE_INFINITY,
  );
  const newCursor = newSummaries.length > 0 ? String(maxSeenNum) : prevLastSeen;

  await recordSuccessfulPoll(connectionId, tenantId, newCursor);

  const result: IngestResult = {
    fetched: rows.length,
    new: newCount,
    errors,
    newCursor,
  };

  logger.info(
    {
      connection: connection.name,
      connectionId,
      tenantId,
      fetched: result.fetched,
      new: result.new,
      errors: result.errors,
      newCursor: result.newCursor,
      pages,
      batches,
      concurrency: CONCURRENCY,
    },
    'ingestion complete',
  );

  return result;
}
