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
  /** Per-execution detail-fetch/parse failures (not fatal — the rest still ingest). */
  errors: number;
  /** Rows validly skipped, NOT errors: list rows without a usable id + executions with no
   *  start time yet. Counted + logged so a schema drift degrades visibly instead of silently. */
  skipped: number;
  /** Cursor we persisted: max numeric id seen, as a string (null if none yet). */
  newCursor: string | null;
  /** Internal UUIDs of the rows newly inserted this run (for turn derivation). */
  newExecutionIds: string[];
}

/** Map a full n8n execution detail into an `executions` row, or null when it can't be
 *  stored — a not-yet-started execution has no `startedAt`, and `executions.started_at` is
 *  NOT NULL. Returning null (rather than throwing) lets the caller skip+count it. */
function mapDetailToRow(
  tenantId: string,
  connectionId: string,
  detail: N8nExecutionDetail,
): NewExecution | null {
  const { startedAt, stoppedAt } = detail;
  if (startedAt === null) return null; // never started → nothing to observe yet; skip

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

/** The outcome of trying to turn one summary into a storable row. `error` = the detail
 *  fetch/parse failed; `skip` = fetched fine but not storable (e.g. not yet started). Both
 *  are per-row and never fatal to the rest of the page. */
type FetchOutcome = { kind: 'row'; row: NewExecution } | { kind: 'error' } | { kind: 'skip' };

/** Fetch one execution's full payload and map it; never throws. */
async function fetchRow(
  n8n: N8nClient,
  tenantId: string,
  connectionId: string,
  summary: N8nExecutionSummary,
): Promise<FetchOutcome> {
  let detail: N8nExecutionDetail;
  try {
    detail = await n8n.getExecution(summary.id);
  } catch (err) {
    logger.warn(
      { err, connectionId, executionId: summary.id },
      'failed to fetch execution detail; skipping',
    );
    return { kind: 'error' };
  }
  const row = mapDetailToRow(tenantId, connectionId, detail);
  if (!row) {
    logger.warn(
      { connectionId, executionId: summary.id, status: detail.status },
      'execution has no start time (not yet started); skipping this row, ingesting the rest',
    );
    return { kind: 'skip' };
  }
  return { kind: 'row', row };
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
  let listSkipped = 0; // list rows the client couldn't read an id from (already logged there)

  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await n8n.listExecutions({ limit: PAGE_LIMIT, cursor });
      pages += 1;
      listSkipped += page.skipped;

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
    return { fetched: 0, new: 0, errors: 1, skipped: 0, newCursor: prevLastSeen, newExecutionIds: [] };
  }

  // --- 2. Fetch full payloads with bounded concurrency. ---
  const rows: NewExecution[] = [];
  let errors = 0;
  let mappingSkipped = 0; // fetched fine but not storable (e.g. not yet started)
  let batches = 0;

  for (let i = 0; i < newSummaries.length; i += CONCURRENCY) {
    const chunk = newSummaries.slice(i, i + CONCURRENCY);
    batches += 1;
    const settled = await Promise.all(
      chunk.map((s) => fetchRow(n8n, tenantId, connectionId, s)),
    );
    for (const outcome of settled) {
      if (outcome.kind === 'row') rows.push(outcome.row);
      else if (outcome.kind === 'error') errors += 1;
      else mappingSkipped += 1;
    }
  }
  const skipped = listSkipped + mappingSkipped;

  // --- 3. Persist rows (idempotent) and advance the cursor. ---
  const insertedIds = await upsertMany(rows);

  const maxSeenNum = newSummaries.reduce<number>(
    (max, s) => Math.max(max, Number(s.id)),
    prevLastSeenNum ?? Number.NEGATIVE_INFINITY,
  );
  const newCursor = newSummaries.length > 0 ? String(maxSeenNum) : prevLastSeen;

  await recordSuccessfulPoll(connectionId, tenantId, newCursor);

  const result: IngestResult = {
    fetched: rows.length,
    new: insertedIds.length,
    errors,
    skipped,
    newCursor,
    newExecutionIds: insertedIds,
  };

  logger.info(
    {
      connection: connection.name,
      connectionId,
      tenantId,
      fetched: result.fetched,
      new: result.new,
      errors: result.errors,
      skipped: result.skipped,
      newCursor: result.newCursor,
      pages,
      batches,
      concurrency: CONCURRENCY,
    },
    'ingestion complete',
  );

  return result;
}
