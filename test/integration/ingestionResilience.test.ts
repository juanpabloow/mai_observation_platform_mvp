import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { encrypt } from '../../src/crypto.js';
import { ingestExecutionsForConnection } from '../../src/ingestion/ingestExecutions.js';
import type { N8nConnectionRow } from '../../src/db/types.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * The 12-day-outage bug: ONE list row with an unexpected shape (a null `startedAt`, or a
 * numeric id, or a missing field) failed the whole-page zod parse, so nothing ingested and
 * the cursor never advanced. This proves the fix: a bad/edge row is skipped + counted, every
 * other row still ingests, and errors stays 0.
 */
const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a null-startedAt / numeric-id / missing-id row NO LONGER kills the page — errors:0, the rest ingest', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const conn = (
    await query<{ id: string }>(
      `INSERT INTO n8n_connections (tenant_id, name, n8n_base_url, n8n_api_key_encrypted)
         VALUES ($1, 'MontserratAI', 'https://stub.local', $2) RETURNING id`,
      [s.tenantId, encrypt('test-key')],
    )
  ).rows[0];
  const connection: N8nConnectionRow = {
    id: conn.id, tenant_id: s.tenantId, name: 'MontserratAI', n8n_base_url: 'https://stub.local',
    n8n_api_key_encrypted: encrypt('test-key'), is_active: true, created_at: new Date(), updated_at: new Date(),
  };

  // The n8n API, stubbed to return the EXACT shapes that broke production.
  const listBody = {
    data: [
      { id: '1701', finished: true, mode: 'trigger', status: 'success', startedAt: '2026-08-25T10:00:00.000Z', stoppedAt: '2026-08-25T10:00:05.000Z', workflowId: 'wf1' },
      { id: 1702, mode: 'trigger', status: 'waiting', startedAt: null, stoppedAt: null, workflowId: 'wf1', someNewFieldN8nAdded: true }, // numeric id + null startedAt + unknown field
      { finished: true, status: 'success', workflowId: 'wf1' }, // NO id at all → unusable list row
    ],
    nextCursor: null,
  };
  const detail1701 = { id: '1701', workflowId: 'wf1', status: 'success', mode: 'trigger', startedAt: '2026-08-25T10:00:00.000Z', stoppedAt: '2026-08-25T10:00:05.000Z', data: { resultData: {} }, workflowData: { name: 'Montse Bot' } };
  const detail1702 = { id: 1702, workflowId: 'wf1', status: 'waiting', mode: 'trigger', startedAt: null, stoppedAt: null }; // not yet started

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const u = String(input);
    if (u.includes('/executions/1701')) return jsonResponse(detail1701);
    if (u.includes('/executions/1702')) return jsonResponse(detail1702);
    if (u.includes('/executions')) return jsonResponse(listBody);
    throw new Error(`unexpected fetch: ${u}`);
  }) as typeof fetch;

  try {
    const r = await ingestExecutionsForConnection(connection);
    assert.equal(r.errors, 0, 'ZERO errors — the bad rows did not fail the page');
    assert.equal(r.new, 1, 'the one finished execution ingested');
    assert.equal(r.skipped, 2, 'skipped = 1 list row without an id + 1 not-yet-started execution');
    assert.equal(r.newCursor, '1702', 'cursor advanced past every id seen (never stuck)');
  } finally {
    globalThis.fetch = realFetch;
  }

  const rows = await query<{ n8n_execution_id: string; status: string; started_at: Date }>(
    `SELECT n8n_execution_id, status, started_at FROM executions WHERE n8n_connection_id = $1 ORDER BY n8n_execution_id`,
    [conn.id],
  );
  assert.deepEqual(rows.rows.map((x) => x.n8n_execution_id), ['1701'], 'only the finished execution is stored');
  assert.equal(rows.rows[0].status, 'success');

  // A successful poll was recorded → the ingestion-freshness signal sees a fresh connection.
  const st = await query<{ n: number }>(
    `SELECT count(*)::int n FROM ingestion_state WHERE n8n_connection_id = $1 AND last_successful_poll_at IS NOT NULL`,
    [conn.id],
  );
  assert.equal(st.rows[0].n, 1, 'recordSuccessfulPoll stamped last_successful_poll_at');
});

test('ingestion-freshness detection: fresh → healthy; stale-by-time and failing → flagged (mirrors /api/health)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const mkConn = async (name: string): Promise<string> =>
    (await query<{ id: string }>(
      `INSERT INTO n8n_connections (tenant_id, name, n8n_base_url, n8n_api_key_encrypted)
         VALUES ($1, $2, 'https://x', 'x') RETURNING id`,
      [s.tenantId, name],
    )).rows[0].id;
  const fresh = await mkConn('fresh');
  const stale = await mkConn('stale');
  const failing = await mkConn('failing');
  await query(
    `INSERT INTO ingestion_state (n8n_connection_id, tenant_id, last_polled_at, last_successful_poll_at, consecutive_failures) VALUES
       ($1, $4, now(), now(), 0),
       ($2, $4, now(), now() - interval '30 minutes', 5),
       ($3, $4, now(), NULL, 25)`,
    [fresh, stale, failing, s.tenantId],
  );
  // The exact predicate from /api/health/route.ts (600s threshold, 20-failure limit), scoped
  // to this tenant's connections so the assertion is deterministic.
  const r = await query<{ id: string }>(
    `SELECT ist.n8n_connection_id AS id FROM ingestion_state ist
       JOIN n8n_connections c ON c.id = ist.n8n_connection_id
      WHERE c.tenant_id = $1
        AND ((ist.last_successful_poll_at IS NOT NULL AND ist.last_successful_poll_at < now() - make_interval(secs => 600))
             OR ist.consecutive_failures >= 20)`,
    [s.tenantId],
  );
  const flagged = new Set(r.rows.map((x) => x.id));
  assert.ok(!flagged.has(fresh), 'a freshly-polled connection is healthy');
  assert.ok(flagged.has(stale), 'a connection whose last success is 30 min ago is stale (would 503)');
  assert.ok(flagged.has(failing), 'a never-succeeded connection with a run of failures is stale');
});
