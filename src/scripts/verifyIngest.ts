/**
 * THROWAWAY verification script. Proves the full ingestion path:
 * crypto round-trip → upsert a test n8n connection → ingest once → ingest again
 * (cursor + idempotency) → inspect stored rows. Safe to delete later.
 *
 * Run with: npm run verify:ingest
 */
import { config } from '../config.js';
import { closePool, query } from '../db/client.js';
import { decrypt, encrypt } from '../crypto.js';
import { getOrCreateTenant } from '../db/repositories/tenants.js';
import { upsertConnectionByName } from '../db/repositories/n8nConnections.js';
import { countByConnection } from '../db/repositories/executions.js';
import { ingestExecutionsForConnection } from '../ingestion/ingestExecutions.js';

function requireTestCredentials(): { baseUrl: string; apiKey: string } {
  const baseUrl = config.TEST_N8N_BASE_URL;
  const apiKey = config.TEST_N8N_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error(
      '\n✖ verify:ingest requires TEST_N8N_BASE_URL and TEST_N8N_API_KEY in your .env:\n' +
        `    TEST_N8N_BASE_URL: ${baseUrl ? 'set' : 'MISSING'}\n` +
        `    TEST_N8N_API_KEY:  ${apiKey ? 'set' : 'MISSING'}\n`,
    );
    process.exit(1);
  }
  return { baseUrl, apiKey };
}

interface SampleRow {
  n8n_execution_id: string;
  status: string;
  workflow_name: string | null;
  started_at: Date;
  has_raw: boolean;
}

async function main(): Promise<void> {
  console.log('\n==================== verify:ingest ====================');

  // 1. Crypto round-trip.
  const secret = 'sample-api-key-✓-12345';
  const decrypted = decrypt(encrypt(secret));
  if (decrypted !== secret) {
    throw new Error('crypto round-trip FAILED: decrypted value did not match');
  }
  console.log('crypto OK');

  // 2. Upsert the test connection under the default tenant (idempotent on name).
  const { baseUrl, apiKey } = requireTestCredentials();
  const tenant = await getOrCreateTenant('MAI');
  const connection = await upsertConnectionByName({
    tenant_id: tenant.id,
    name: 'my-test-instance',
    n8n_base_url: baseUrl,
    n8n_api_key_encrypted: encrypt(apiKey),
  });
  console.log(`tenant: ${tenant.id} (${tenant.name})`);
  console.log(`connection: ${connection.id} (name=${connection.name})`);

  // 3. First ingest.
  const result1 = await ingestExecutionsForConnection(connection);
  console.log('IngestResult #1:', result1);
  const countAfter1 = await countByConnection(connection.id);
  console.log('count after run 1:', countAfter1);

  // 4. Second ingest immediately — should be a no-op (cursor + idempotency).
  const result2 = await ingestExecutionsForConnection(connection);
  console.log('IngestResult #2:', result2);
  const countAfter2 = await countByConnection(connection.id);
  console.log('count after run 2:', countAfter2);

  const idempotent = result2.new === 0 && countAfter2 === countAfter1;
  console.log(
    idempotent
      ? '✓ cursor + idempotency OK (run 2 new=0, count unchanged)'
      : '✗ idempotency check FAILED',
  );

  // 5. Show 3 sample stored rows.
  const samples = await query<SampleRow>(
    `SELECT n8n_execution_id, status, workflow_name, started_at,
            (raw_data IS NOT NULL) AS has_raw
       FROM executions
      WHERE n8n_connection_id = $1
      ORDER BY started_at DESC
      LIMIT 3`,
    [connection.id],
  );
  console.log('\n3 sample stored rows:');
  for (const row of samples.rows) {
    console.log(
      `  - id=${row.n8n_execution_id} status=${row.status} ` +
        `workflow=${row.workflow_name ?? '(null)'} ` +
        `startedAt=${row.started_at.toISOString()} raw_data_present=${row.has_raw}`,
    );
  }
  console.log('=======================================================\n');

  if (!idempotent) {
    throw new Error('Idempotency check failed.');
  }
}

main()
  .catch((err: unknown) => {
    console.error('\n✖ verify:ingest failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => {
    void closePool();
  });
