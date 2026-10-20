import { strict as assert } from 'node:assert';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * PL-1 §2 fail-safe: a thrown pipeline operation must NEVER fail the message push. We replace the
 * pipeline engine so openOnInbound throws; the hook (hooks.ts) must swallow it, the push must still
 * store the message and return 2xx, and the failure must be counted (recordPipelineFailure). The
 * other engine exports are stubbed because the route's import surface must stay complete. The
 * failures module is mocked with a local counter (same pattern as attributionFailsafe) so the count
 * is observable regardless of module-identity across the web/react-server boundary.
 */
let failures = 0;
const engineUrl = pathToFileURL(resolvePath(process.cwd(), 'src/pipeline/engine.ts')).href;
mock.module(engineUrl, {
  namedExports: {
    openOnInbound: async () => { throw new Error('forced pipeline failure'); },
    onBookingCreated: async () => {},
    onAppointmentStatusChanged: async () => {},
    bookingActor: () => ({ kind: 'system' as const }),
  },
});
const failuresUrl = pathToFileURL(resolvePath(process.cwd(), 'src/pipeline/failures.ts')).href;
mock.module(failuresUrl, {
  namedExports: {
    recordPipelineFailure: () => { failures += 1; },
    getPipelineFailureCount: () => failures,
  },
});

const { POST } = await import('../../web/app/api/handoff/v1/messages/route.js');
after(closeDb);

test('PL-1 fail-safe: a thrown pipeline open never fails the message push', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['handoff']);
    const before = failures;

    const res = await POST(new Request('http://t/api/handoff/v1/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rawToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workflow_ref: wfRef, conversation_ref: '573001234567', sender: 'user', text: 'hola', external_message_id: 'pf1' }),
    }));

    assert.ok(res.status === 201 || res.status === 200, `push succeeded despite the pipeline throwing (got ${res.status})`);
    assert.equal((await query<{ n: number }>(`SELECT count(*)::int n FROM handoff_messages WHERE tenant_id=$1`, [s.tenantId])).rows[0].n, 1, 'the message was stored');
    assert.ok(failures > before, 'the pipeline failure was counted');
    assert.equal((await query<{ n: number }>(`SELECT count(*)::int n FROM opportunities WHERE tenant_id=$1`, [s.tenantId])).rows[0].n, 0, 'no opportunity (the open threw)');
  } finally { await cleanupTenant(s.tenantId); }
});
