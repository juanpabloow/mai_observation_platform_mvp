import { logger } from '../logger.js';
import { extractLlmUsage } from './llmUsage.js';
import {
  getExecutionsForLlmUsageByIds,
  listExecutionsForLlmUsagePage,
  persistExecutionLlmUsage,
  type ExecutionForLlmUsage,
} from '../db/repositories/llmUsage.js';

/**
 * COSTOS DE IA — derive LLM usage for executions, on ingest (only the new rows) and by backfill.
 * Best-effort like turn derivation: one bad execution is logged and skipped, never thrown.
 */

export interface LlmUsageCounts {
  processed: number;
  withCalls: number;
  withoutData: number;
  errors: number;
}

const empty = (): LlmUsageCounts => ({ processed: 0, withCalls: 0, withoutData: 0, errors: 0 });

async function deriveOne(execution: ExecutionForLlmUsage, counts: LlmUsageCounts): Promise<void> {
  counts.processed += 1;
  try {
    const extraction = extractLlmUsage(execution.raw_data);
    await persistExecutionLlmUsage(execution, extraction);
    if (extraction.calls > 0) counts.withCalls += 1;
    if (!extraction.hasRunData) counts.withoutData += 1;
  } catch (err) {
    counts.errors += 1;
    logger.error({ err, executionId: execution.id }, 'llm usage derivation failed for execution; skipping');
  }
}

export async function deriveLlmUsageForExecutionIds(params: {
  tenantId: string;
  executionIds: string[];
}): Promise<LlmUsageCounts> {
  const counts = empty();
  if (params.executionIds.length === 0) return counts;
  const executions = await getExecutionsForLlmUsageByIds({ tenantId: params.tenantId, ids: params.executionIds });
  for (const execution of executions) await deriveOne(execution, counts);
  return counts;
}

const BACKFILL_BATCH = 200;

/** Walk every execution (all tenants). Default: only the ones never scanned; `rescan` redoes all. */
export async function backfillLlmUsage(options: { rescan: boolean }): Promise<LlmUsageCounts> {
  const counts = empty();
  let afterId: string | null = null;
  for (;;) {
    const page = await listExecutionsForLlmUsagePage({
      afterId,
      limit: BACKFILL_BATCH,
      onlyUnscanned: !options.rescan,
    });
    if (page.length === 0) break;
    for (const execution of page) await deriveOne(execution, counts);
    afterId = page[page.length - 1].id;
    if (page.length < BACKFILL_BATCH) break;
  }
  return counts;
}
