import { backfillLlmUsage } from '../analytics/deriveLlmUsage.js';
import { closePool } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * COSTOS DE IA — derive LLM usage for executions ingested before migration 1827 (or never read).
 * Idempotent and resumable: by default only executions without a scan row are read.
 *
 *   npm run llm-usage:backfill              # executions never scanned
 *   npm run llm-usage:backfill -- --rescan  # every execution again (after an extractor change)
 */
async function main(): Promise<void> {
  const rescan = process.argv.includes('--rescan');
  logger.info({ rescan }, 'llm usage backfill starting');
  const counts = await backfillLlmUsage({ rescan });
  logger.info(counts, 'llm usage backfill complete');
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'llm usage backfill failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
