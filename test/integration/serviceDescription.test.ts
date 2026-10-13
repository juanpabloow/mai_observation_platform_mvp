import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import type { MigrationBuilder } from 'node-pg-migrate';
import { pool } from '../../src/db/client.js';
import { up as expandDescriptions, down as restoreDescriptions } from '../../migrations/1799000000000_service-description-expansion.js';
import { createService, getServiceById, updateService } from '../../src/db/repositories/scheduling/services.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

after(closeDb);

const is23514 = (e: unknown) => (e as { code?: string }).code === '23514';

test('services.description: repo round-trip, DB CHECK (≤2000, non-blank), and the machine API returns complete text', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const DESC = 'Incluye lavado, corte a tijera y peinado final.\n\n'.repeat(16).trim();
    assert.ok(DESC.length > 500);

    // CREATE / EDIT / CLEAR a description via the repo (the path the admin action writes).
    assert.equal((await updateService(s.tenantId, s.clientId, s.serviceHaircut, { description: DESC }))?.description, DESC);
    assert.equal((await getServiceById(s.tenantId, s.clientId, s.serviceHaircut))?.description, DESC);
    assert.equal((await updateService(s.tenantId, s.clientId, s.serviceHaircut, { description: null }))?.description, null, 'cleared → null');
    await updateService(s.tenantId, s.clientId, s.serviceHaircut, { description: DESC }); // set again for the API check

    // DB CHECK: exactly 2000 is allowed; 2001 is refused; a blank/whitespace value is refused
    // (the server maps blanks to NULL first — this is the backstop against a direct write).
    const maximumDescription = 'a'.repeat(2000);
    assert.equal(
      (await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Max desc', description: maximumDescription, durationMin: 30 })).description,
      maximumDescription,
      '2000 chars is accepted',
    );
    await assert.rejects(
      createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Over', description: 'a'.repeat(2001), durationMin: 30 }),
      is23514,
      '2001 chars is refused by the DB CHECK',
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

    const { GET: getPublicServices } = await import('../../web/app/api/booking/[slug]/services/route.js');
    const publicResponse = await getPublicServices(new Request(`http://t/api/booking/${s.siteSlug}/services`), {
      params: Promise.resolve({ slug: s.siteSlug }),
    });
    assert.equal(publicResponse.status, 200);
    const publicBody = await publicResponse.json() as { services: Array<{ id: string; description: string | null }> };
    assert.equal(publicBody.services.find((service) => service.id === s.serviceHaircut)?.description, DESC,
      'public booking receives the complete description too, without truncation');

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

async function migrationSql(migrate: (pgm: MigrationBuilder) => Promise<void>): Promise<string> {
  const statements: string[] = [];
  await migrate({ sql: (sql: string) => { statements.push(sql); } } as unknown as MigrationBuilder);
  return statements.join('\n');
}

test('description expansion preserves data and refuses a lossy downgrade', async () => {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // A connection-local table shadows public.services; no other tenant or test is altered.
    await db.query(`CREATE TEMP TABLE services (
      description text,
      CONSTRAINT services_description_len_check
        CHECK (description IS NULL OR (char_length(description) <= 500 AND btrim(description) <> ''))
    ) ON COMMIT DROP`);
    const original = 'a'.repeat(500);
    await db.query('INSERT INTO pg_temp.services (description) VALUES ($1)', [original]);
    await db.query(await migrationSql(expandDescriptions));
    assert.equal((await db.query('SELECT description FROM pg_temp.services')).rows[0].description, original);
    const longText = 'b'.repeat(760);
    await db.query('INSERT INTO pg_temp.services (description) VALUES ($1)', [longText]);
    await db.query('SAVEPOINT downgrade_attempt');
    await assert.rejects(db.query(await migrationSql(restoreDescriptions)), is23514);
    await db.query('ROLLBACK TO SAVEPOINT downgrade_attempt');
    assert.equal((await db.query('SELECT description FROM pg_temp.services WHERE description = $1', [longText])).rows[0].description, longText);
    await db.query('INSERT INTO pg_temp.services (description) VALUES ($1)', ['c'.repeat(2000)]);
    // Only synthetic, connection-local rows are removed to verify a compatible downgrade.
    await db.query('DELETE FROM pg_temp.services WHERE char_length(description) > 500');
    await db.query(await migrationSql(restoreDescriptions));
    assert.equal((await db.query('SELECT description FROM pg_temp.services')).rows[0].description, original);
    await assert.rejects(db.query('INSERT INTO pg_temp.services (description) VALUES ($1)', ['d'.repeat(501)]), is23514);
  } finally {
    await db.query('ROLLBACK');
    db.release();
  }
});
