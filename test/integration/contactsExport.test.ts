import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { createCampaign } from '../../src/db/repositories/attribution.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * AT-UI — the contacts CSV export carries the attribution origin (origin_group, Campaña, Anuncio),
 * flags a test-ad origin, and NEVER leaks ctwa_clid. Behavioral harness: real scope + stubbed
 * session/Next boundaries (mirrors campaignsActions.test.ts).
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (id: string) => { CURRENT = { id, email: `${id.slice(0, 8)}@test.local` }; };

const { GET } = await import('../../web/app/api/crm/v1/contacts/export/[clientId]/route.js');
after(closeDb);
const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

test('CSV export: origin_group / Campaña / Anuncio columns, test-ad flagged, never ctwa_clid', async () => {
  const s = await seedScenario({ enableCrm: true, enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    asUser(agency);
    const wfRef = `wf-${randomUUID().slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const camp = await createCampaign({ tenantId: s.tenantId, clientId: s.clientId, name: 'Campaña Primavera' });
    const ad = await one<{ id: string }>(
      `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, name, headline, campaign_id)
         VALUES ($1,$2,'meta','ad','777','Anuncio Alfa','Agenda hoy',$3) RETURNING id`,
      [s.tenantId, s.clientId, camp.id],
    );
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead Alfa', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
    const cv = await one<{ id: string }>(
      `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [s.tenantId, wfRef, `cv-${randomUUID().slice(0, 8)}`, contact],
    );
    const m = await one<{ id: string }>(
      `INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at) VALUES ($1,$2,'user','received','ref','text', now()) RETURNING id`,
      [s.tenantId, cv.id],
    );
    const t = await one<{ id: string }>(
      `INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, ctwa_clid, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,'SECRET-CLID-123', now()) RETURNING id`,
      [s.tenantId, s.clientId, contact, cv.id, m.id, ad.id],
    );
    await query(`UPDATE contacts SET origin_kind='meta_ad', first_touch_id=$1 WHERE id=$2`, [t.id, contact]);

    const res = await GET(new Request(`http://t/api/crm/v1/contacts/export/${s.clientId}`), { params: Promise.resolve({ clientId: s.clientId }) });
    assert.equal(res.status, 200);
    const csv = await res.text();
    const header = csv.split('\r\n')[0];
    assert.ok(header.includes('Origen'), 'Origen column');
    assert.ok(header.includes('Campaña'), 'Campaña column');
    assert.ok(header.includes('Anuncio'), 'Anuncio column');
    assert.ok(csv.includes('Anuncio'), 'origin group label present');
    assert.ok(csv.includes('Campaña Primavera'), 'campaign name exported');
    assert.ok(csv.includes('Anuncio Alfa'), 'ad name exported');
    assert.ok(!csv.includes('SECRET-CLID-123'), 'ctwa_clid NEVER exported');
    assert.ok(!csv.toLowerCase().includes('ctwa'), 'no ctwa_clid header or value');
  } finally { await cleanupTenant(s.tenantId); }
});

test('CSV export: a test-ad origin shows "Anuncio de prueba" and the Origen filter applies', async () => {
  const s = await seedScenario({ enableCrm: true, enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    asUser(agency);
    const wfRef = `wf-${randomUUID().slice(0, 8)}`;
    await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const testAd = await one<{ id: string }>(
      `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id, headline) VALUES ($1,$2,'meta','ad','TEST-1','Prueba') RETURNING id`,
      [s.tenantId, s.clientId],
    );
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead Test', channelUserId: `wa:${randomUUID().slice(0, 8)}` });
    const cv = await one<{ id: string }>(`INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref, contact_id) VALUES ($1,$2,$3,$4) RETURNING id`, [s.tenantId, wfRef, `cv-${randomUUID().slice(0, 8)}`, contact]);
    const m = await one<{ id: string }>(`INSERT INTO handoff_messages (tenant_id, conversation_id, sender, status, text, content_type, occurred_at) VALUES ($1,$2,'user','received','ref','text', now()) RETURNING id`, [s.tenantId, cv.id]);
    const t = await one<{ id: string }>(`INSERT INTO attribution_touches (tenant_id, client_id, contact_id, conversation_id, message_id, ad_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`, [s.tenantId, s.clientId, contact, cv.id, m.id, testAd.id]);
    await query(`UPDATE contacts SET origin_kind='meta_ad', first_touch_id=$1 WHERE id=$2`, [t.id, contact]);

    const res = await GET(new Request(`http://t/api/crm/v1/contacts/export/${s.clientId}?origin=anuncio`), { params: Promise.resolve({ clientId: s.clientId }) });
    const csv = await res.text();
    assert.ok(csv.includes('Anuncio de prueba'), 'a test-ad origin reads "Anuncio de prueba"');
    assert.ok(csv.includes('Lead Test'), 'the ad contact is in the anuncio-filtered export');
  } finally { await cleanupTenant(s.tenantId); }
});
