/**
 * THROWAWAY verification script (Step 3). Hits a REAL n8n instance using the
 * TEST_N8N_* credentials from .env and prints a compact summary. Proves the
 * typed client works end to end. Safe to delete in a later step.
 *
 * Run with: npm run verify:n8n
 *
 * Never prints full payloads or the API key.
 */
import { config } from '../config.js';
import { createN8nClient, N8nApiError } from '../n8n/client.js';

/** Read + require the test n8n credentials, erroring clearly if absent. */
function requireTestCredentials(): { baseUrl: string; apiKey: string } {
  const baseUrl = config.TEST_N8N_BASE_URL;
  const apiKey = config.TEST_N8N_API_KEY;
  if (!baseUrl || !apiKey) {
    console.error(
      '\n✖ verify:n8n requires TEST_N8N_BASE_URL and TEST_N8N_API_KEY in your .env:\n' +
        `    TEST_N8N_BASE_URL: ${baseUrl ? 'set' : 'MISSING'}\n` +
        `    TEST_N8N_API_KEY:  ${apiKey ? 'set' : 'MISSING'}\n`,
    );
    process.exit(1);
  }
  return { baseUrl, apiKey };
}

/** Object.keys for a value that may or may not be a plain object. */
function topLevelKeys(value: unknown): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/** Safely read a nested property without assuming structure. */
function getProp(value: unknown, key: string): unknown {
  if (value !== null && typeof value === 'object') {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

async function main(): Promise<void> {
  const { baseUrl, apiKey } = requireTestCredentials();
  const client = createN8nClient({ baseUrl, apiKey });

  // 1. List up to 10 executions (summaries only).
  const list = await client.listExecutions({ limit: 10 });

  console.log('\n==================== verify:n8n ====================');
  console.log(`Fetched ${list.data.length} execution(s). nextCursor: ${list.nextCursor ?? 'null'}`);
  for (const e of list.data) {
    console.log(
      `  - id=${e.id} status=${e.status} workflowId=${e.workflowId} startedAt=${e.startedAt}`,
    );
  }

  const first = list.data[0];
  if (!first) {
    console.log('\nNo executions returned — skipping detail fetch.');
    console.log('====================================================\n');
    return;
  }

  // 2. Fetch the FIRST execution in full and inspect its shape (keys only).
  const detail = await client.getExecution(first.id);

  const dataKeys = topLevelKeys(detail.data);
  const resultData = getProp(detail.data, 'resultData');
  const runData = getProp(resultData, 'runData');
  const runDataKeys = topLevelKeys(runData);

  console.log('\nFirst execution detail:');
  console.log(`  id:                  ${detail.id}`);
  console.log(`  workflow name:       ${detail.workflowData?.name ?? '(not present)'}`);
  console.log(`  data top-level keys: [${dataKeys.join(', ')}]`);
  console.log(`  runData node keys:   [${runDataKeys.join(', ')}]`);
  console.log('====================================================\n');
}

main().catch((err: unknown) => {
  if (err instanceof N8nApiError) {
    console.error(`\n✖ verify:n8n failed: ${err.message}`);
    if (err.status) {
      console.error(`    HTTP status: ${err.status}`);
    }
    if (err.bodySnippet) {
      console.error(`    body snippet: ${err.bodySnippet}`);
    }
  } else {
    console.error('\n✖ verify:n8n failed:', err instanceof Error ? err.message : err);
  }
  process.exitCode = 1;
});
