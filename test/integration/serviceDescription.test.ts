import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { createService, getServiceById, updateService } from '../../src/db/repositories/scheduling/services.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

after(closeDb);

const is23514 = (e: unknown) => (e as { code?: string }).code === '23514';

test('services.description: repo round-trip, DB CHECK (≤500, non-blank), and the machine API returns it', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const DESC = 'Incluye lavado, corte a tijera y peinado final.';

    // CREATE / EDIT / CLEAR a description via the repo (the path the admin action writes).
    assert.equal((await updateService(s.tenantId, s.clientId, s.serviceHaircut, { description: DESC }))?.description, DESC);
    assert.equal((await getServiceById(s.tenantId, s.clientId, s.serviceHaircut))?.description, DESC);
    assert.equal((await updateService(s.tenantId, s.clientId, s.serviceHaircut, { description: null }))?.description, null, 'cleared → null');
    await updateService(s.tenantId, s.clientId, s.serviceHaircut, { description: DESC }); // set again for the API check

    // DB CHECK: exactly 500 is allowed; 501 is refused; a blank/whitespace value is refused
    // (the server maps blanks to NULL first — this is the backstop against a direct write).
    const c500 = 'a'.repeat(500);
    assert.equal(
      (await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Max desc', description: c500, durationMin: 30 })).description,
      c500,
      '500 chars is accepted',
    );
    await assert.rejects(
      createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Over', description: 'a'.repeat(501), durationMin: 30 }),
      is23514,
      '501 chars is refused by the DB CHECK',
    );
    await assert.rejects(
      createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Blank', description: '   ', durationMin: 30 }),
      is23514,
      'a blank/whitespace description is refused (must be NULL)',
    );

    // MACHINE API: GET /api/scheduling/v1/services returns `description` — a string when set,
    // null when not. Executed through the real route handler + auth.
    const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read']);
    const { GET } = await import('../../web/app/api/scheduling/v1/services/route.js');
    const req = new Request(`http://t/api/scheduling/v1/services?site_id=${s.siteId}`, {
      headers: { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef },
    });
    const res = await GET(req);
    assert.equal(res.status, 200, 'the machine API responds 200');
    const body = (await res.json()) as { services: Array<{ id: string; name: string; description: string | null }> };

    const haircut = body.services.find((x) => x.id === s.serviceHaircut);
    const beard = body.services.find((x) => x.id === s.serviceBeard);
    assert.ok(haircut && beard, 'both enabled services are listed');
    assert.equal(haircut!.description, DESC, 'description present for a service that has one');
    assert.equal(beard!.description, null, 'description is null for a service without one');

    // ISOLATION unchanged: the list is exactly THIS site's enabled services (the Max/Over/Blank
    // rows were never enabled at the site, and no other client's service appears).
    const enabled = new Set([s.serviceHaircut, s.serviceBeard, s.serviceColor]);
    assert.ok(body.services.every((x) => enabled.has(x.id)), 'only this site/client services are returned');

    if (process.env.PRINT_API_SAMPLE) {
      console.error('SERVICES_API_SAMPLE', JSON.stringify(body, null, 2));
    }
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
