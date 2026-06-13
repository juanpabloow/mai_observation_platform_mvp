import { backfillTurns } from '../conversations/deriveTurns.js';
import { closePool } from '../db/client.js';
import { logger } from '../logger.js';

/**
 * One-time / re-runnable backfill: derive conversation turns for every existing
 * execution of every workflow that has conversation mappings. Idempotent
 * (UNIQUE execution_id) — safe to run repeatedly.
 *
 *   npm run derive:backfill              # all workflows with mappings
 *   npm run derive:backfill -- <wfId>    # scope to one n8n workflow id
 */
async function main(): Promise<void> {
  const workflowId = process.argv[2]?.trim() || undefined;
  logger.info(
    { workflowId: workflowId ?? '(all workflows with conversation mappings)' },
    'turn backfill starting',
  );

  const counts = await backfillTurns(workflowId);

  logger.info(counts, 'turn backfill complete');
  // Machine-readable summary on stdout for scripting/verification.
  console.log(JSON.stringify(counts, null, 2));
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'turn backfill failed');
    process.exitCode = 1;
  })
  .finally(() => closePool());
