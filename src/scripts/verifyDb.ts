/**
 * THROWAWAY verification script. Proves the schema + repositories work end to
 * end, including the ON CONFLICT DO NOTHING idempotency guarantee.
 * Safe to delete in a later step.
 *
 * Run with: npm run verify:db
 */
import { closePool } from '../db/client.js';
import { getOrCreateTenant } from '../db/repositories/tenants.js';
import { insertConnection } from '../db/repositories/n8nConnections.js';
import { countByConnection, upsertMany, type NewExecution } from '../db/repositories/executions.js';
import { logger } from '../logger.js';

async function main(): Promise<void> {
  // 1. Tenant + n8n connection (the thing executions belong to).
  const tenant = await getOrCreateTenant('verify-db-tenant');
  const connection = await insertConnection({
    tenant_id: tenant.id,
    name: 'verify-db-connection',
    n8n_base_url: 'https://n8n.example.test',
    n8n_api_key_encrypted: 'placeholder-encrypted-key',
  });
  logger.info({ tenantId: tenant.id, connectionId: connection.id }, 'inserted test tenant + connection');

  // 2. Build one fake execution for that connection.
  const execution: NewExecution = {
    tenant_id: tenant.id,
    n8n_connection_id: connection.id,
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
  const countAfterFirst = await countByConnection(connection.id);

  // 3. Run upsertMany AGAIN with the SAME execution → should insert nothing.
  const secondInserted = await upsertMany([execution]);
  const countAfterSecond = await countByConnection(connection.id);

  const idempotent = countAfterSecond === 1 && secondInserted === 0;

  console.log('\n================ verifyDb results ================');
  console.log('Tenant:', tenant.id, `(${tenant.name})`);
  console.log('Connection:', connection.id, `(${connection.name})`);
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
