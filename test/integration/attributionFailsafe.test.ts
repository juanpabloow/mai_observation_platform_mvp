import { strict as assert } from 'node:assert';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * AT-1 §3 — a forced attribution failure must NEVER fail the message write. We replace the
 * attribution ingest module so ingestLiveReferral throws; the push must still store the message
 * and return 2xx, and the failure must be counted (recordAttributionFailure). ensureInboundOrigin
 * is stubbed to a no-op (the referral path throws first; it is on the module surface the route
 * imports, so the full export set must be present).
 */
let failures = 0;
const ingestUrl = pathToFileURL(resolvePath(process.cwd(), 'src/attribution/ingest.ts')).href;
mock.module(ingestUrl, {
  namedExports: {
    parseReferral: (metadata: Record<string, unknown> | null) =>
      metadata && metadata.referral_source_id
        ? { present: true, ok: true, value: { sourceType: 'ad', sourceId: String(metadata.referral_source_id), sourceUrl: null, ctwaClid: null, headline: null, body: null, mediaType: null } }
        : { present: false },
    ingestLiveReferral: async () => { throw new Error('forced attribution failure'); },
    ensureInboundOrigin: async () => ({ set: false }),
    recordAttributionFailure: () => { failures += 1; },
  },
});

const { POST } = await import('../../web/app/api/handoff/v1/messages/route.js');
after(closeDb);

test('AT-1 fail-safe: a thrown attribution never fails the message push', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['handoff']);
    const before = failures;

    const res = await POST(new Request('http://t/api/handoff/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_ref: wfRef, conversation_ref: '573001234567', sender: 'user', text: 'hola', external_message_id: 'mf1', metadata: { referral_source_type: 'ad', referral_source_id: '999' } }),
    }));

    assert.ok(res.status === 201 || res.status === 200, `push succeeded despite attribution throwing (got ${res.status})`);
    assert.equal((await query<{ n: number }>(`SELECT count(*)::int n FROM handoff_messages WHERE tenant_id=$1`, [s.tenantId])).rows[0].n, 1, 'the message was stored');
    assert.ok(failures > before, 'the attribution failure was counted');
  } finally { await cleanupTenant(s.tenantId); }
});
