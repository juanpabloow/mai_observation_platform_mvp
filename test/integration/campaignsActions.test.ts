import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * AT-2 §4 — the Campañas permission matrix + validation, by hitting the server ACTIONS directly
 * (the enforcement points; the pages/routes delegate to the SAME gate + predicates). Behavioral
 * harness: real scope, stubbed session + Next boundaries (mirrors attributionManual.test.ts).
 *
 * MANAGE (create/edit/end/assign) = agency OR client owner; a Setter is refused. Attribution
 * SETTINGS (brief window) = agency only (a member, incl. a client owner, throws). Module off,
 * cross-client, and a too-long brief are all refused.
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

const { createCampaignAction, updateCampaignAction, endCampaignAction, assignAdsToCampaignAction, createAdAction, updateAdAction } = await import('../../web/lib/campaignsActions.js');
const { setAttributionBriefWindowDaysAction } = await import('../../web/lib/attributionActions.js');
after(closeDb);

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];

test('AT-2 manage: agency ✓, client owner ✓, setter ✗ — create campaign', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });

    asUser(agency);
    assert.equal((await createCampaignAction({ clientId: s.clientId, name: 'Agencia' })).ok, true);
    asUser(owner);
    assert.equal((await createCampaignAction({ clientId: s.clientId, name: 'Dueño' })).ok, true);
    asUser(setter);
    assert.equal((await createCampaignAction({ clientId: s.clientId, name: 'Setter' })).ok, false, 'a setter cannot create campaigns');
    assert.equal(await one<{ n: number }>(`SELECT count(*)::int n FROM campaigns WHERE tenant_id=$1`, [s.tenantId]).then((r) => r.n), 2);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 manage: module OFF → create/assign refused', async () => {
  const s = await seedScenario({ enableCampaigns: false });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    asUser(agency);
    assert.equal((await createCampaignAction({ clientId: s.clientId, name: 'X' })).ok, false, 'module off → refused');
    assert.equal((await assignAdsToCampaignAction(s.clientId, [s.clientId], null)).ok, false);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 manage: cross-client refused', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const ownerOfA = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    asUser(ownerOfA);
    assert.equal((await createCampaignAction({ clientId: s.otherClientId, name: 'B' })).ok, false, 'owner of A cannot create in B');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 validation: a brief over 1500 chars is refused server-side', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    asUser(agency);
    const r = await createCampaignAction({ clientId: s.clientId, name: 'Larga', botBrief: 'x'.repeat(1501) });
    assert.equal(r.ok, false);
    const ok = await createCampaignAction({ clientId: s.clientId, name: 'OK', botBrief: 'x'.repeat(1500) });
    assert.equal(ok.ok, true);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 assign: validates campaign ownership + ad ids; end finalizes', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    asUser(agency);
    const created = await createCampaignAction({ clientId: s.clientId, name: 'Camp' });
    assert.ok(created.ok && created.id);
    const campId = created.id!;
    const adId = (await one<{ id: string }>(
      `INSERT INTO ads (tenant_id, client_id, platform, source_type, external_id) VALUES ($1,$2,'meta','ad','900') RETURNING id`,
      [s.tenantId, s.clientId],
    )).id;

    assert.equal((await assignAdsToCampaignAction(s.clientId, [adId], campId)).ok, true);
    assert.equal((await assignAdsToCampaignAction(s.clientId, [adId], '00000000-0000-0000-0000-000000000000')).ok, false, 'unknown campaign refused');
    assert.equal((await assignAdsToCampaignAction(s.clientId, [], campId)).ok, false, 'no ads selected refused');

    const upd = await updateCampaignAction(s.clientId, campId, { status: 'paused' });
    assert.equal(upd.ok, true);
    assert.equal((await endCampaignAction(s.clientId, campId)).ok, true);
    assert.equal(await one<{ status: string }>(`SELECT status FROM campaigns WHERE id=$1`, [campId]).then((r) => r.status), 'ended');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2 settings: brief window is AGENCY ONLY and bounded', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });

    asUser(agency);
    assert.equal((await setAttributionBriefWindowDaysAction(s.clientId, 14)).ok, true);
    assert.equal(await one<{ d: number }>(`SELECT brief_window_days d FROM attribution_settings WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.clientId]).then((r) => r.d), 14);
    assert.equal((await setAttributionBriefWindowDaysAction(s.clientId, 0)).ok, false, 'below 1 refused');
    assert.equal((await setAttributionBriefWindowDaysAction(s.clientId, 999)).ok, false, 'above 90 refused');

    // A client OWNER is a member → requireFullAccessForAction THROWS (a settings write is agency-only).
    asUser(owner);
    await assert.rejects(() => setAttributionBriefWindowDaysAction(s.clientId, 10), /Forbidden/);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2b ads: pre-register — agency ✓, setter ✗; duplicate refused; validation; per-client id', async () => {
  const s = await seedScenario({ enableCampaigns: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });

    asUser(agency);
    const created = await createAdAction({ clientId: s.clientId, externalId: '900999', name: 'Factos Falla', botNote: 'nota' });
    assert.ok(created.ok && created.id, 'agency pre-registers an ad');
    // duplicate id in the SAME client → refused with a clear message.
    const dup = await createAdAction({ clientId: s.clientId, externalId: '900999' });
    assert.equal(dup.ok, false);
    assert.match(dup.error ?? '', /Ya existe/);
    // the SAME id in ANOTHER client is allowed (uniqueness is per client).
    assert.equal((await createAdAction({ clientId: s.otherClientId, externalId: '900999' })).ok, true);
    // validation: non-digit id and an over-long note are refused.
    assert.equal((await createAdAction({ clientId: s.clientId, externalId: 'abc' })).ok, false);
    assert.equal((await createAdAction({ clientId: s.clientId, externalId: '900998', botNote: 'x'.repeat(501) })).ok, false);

    // edit name + note.
    assert.equal((await updateAdAction(s.clientId, created.id!, { name: 'Falla v2', botNote: 'otra' })).ok, true);
    const row = await one<{ name: string; bot_note: string }>(`SELECT name, bot_note FROM ads WHERE id=$1`, [created.id]);
    assert.deepEqual({ n: row.name, b: row.bot_note }, { n: 'Falla v2', b: 'otra' });

    // a setter can neither pre-register nor edit.
    asUser(setter);
    assert.equal((await createAdAction({ clientId: s.clientId, externalId: '900997' })).ok, false);
    assert.equal((await updateAdAction(s.clientId, created.id!, { name: 'x' })).ok, false);
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-2b ads: module OFF and cross-client refused', async () => {
  const off = await seedScenario({ enableCampaigns: false });
  try {
    const agency = await seedMember(off.tenantId, { role: 'owner' });
    asUser(agency);
    assert.equal((await createAdAction({ clientId: off.clientId, externalId: '900999' })).ok, false, 'module off → refused');
  } finally { await cleanupTenant(off.tenantId); }

  const s = await seedScenario({ enableCampaigns: true });
  try {
    const ownerA = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    asUser(ownerA);
    assert.equal((await createAdAction({ clientId: s.otherClientId, externalId: '900999' })).ok, false, 'owner of A cannot pre-register in B');
  } finally { await cleanupTenant(s.tenantId); }
});
