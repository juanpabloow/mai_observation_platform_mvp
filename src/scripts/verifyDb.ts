/**
 * THROWAWAY verification script (Step 2). Proves the schema + repositories work
 * end to end, including the ON CONFLICT DO NOTHING idempotency guarantee.
 * Safe to delete in a later step.
 *
 * Run with: npm run verify:db   (or: npx tsx src/scripts/verifyDb.ts)
 */
import { closePool } from '../db/client.js';
import { insertClient } from '../db/repositories/clients.js';
import { countByClient, upsertMany, type NewExecution } from '../db/repositories/executions.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
  // 1. Insert a test client.
  const client = await insertClient({
    name: 'verify-test-client',
    n8n_base_url: 'https://n8n.example.test',
    n8n_api_key_encrypted: 'placeholder-encrypted-key',
  });
  logger.info({ clientId: client.id }, 'inserted test client');

  // 2. Build one fake execution for that client.
  const execution: NewExecution = {
    client_id: client.id,
    n8n_execution_id: 'exec-verify-0001',
    n8n_workflow_id: 'wf-verify-0001',
    workflow_name: 'Verification Workflow',
    status: 'success',
    mode: 'trigger',
    started_at: new Date(),
    stopped_at: new Date(),
    duration_ms: 1234,
    raw_data: { hello: 'world', nested: { count: 1 } },
  };

  const firstInserted = await upsertMany([execution]);
  const countAfterFirst = await countByClient(client.id);

  // 3. Run upsertMany AGAIN with the SAME execution → should insert nothing.
  const secondInserted = await upsertMany([execution]);
  const countAfterSecond = await countByClient(client.id);

  const idempotent = countAfterSecond === 1 && secondInserted === 0;

  // Human-readable summary.
  console.log('\n================ verifyDb results ================');
  console.log('Client row:');
  console.dir(client, { depth: null });
  console.log('\nRows inserted on 1st upsertMany:      ', firstInserted);
  console.log('Execution count after 1st upsert:     ', countAfterFirst);
  console.log('Rows inserted on 2nd upsertMany (dup):', secondInserted);
  console.log('Execution count after 2nd upsert:     ', countAfterSecond);
  console.log(
    idempotent
      ? '\n✓ ON CONFLICT DO NOTHING works — count stayed at 1.'
      : '\n✗ Idempotency check FAILED.',
  );
  console.log('==================================================\n');

  if (!idempotent) {
    throw new Error('Idempotency check failed: duplicate execution was inserted.');
  }
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'verifyDb failed');
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
