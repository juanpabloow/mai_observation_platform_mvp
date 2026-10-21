import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario } from './fixtures.js';

/**
 * PL-2 §8 — the pipeline PERMISSION MATRIX + action behaviors, by hitting the server actions
 * directly. Working the pipeline (qualify/unqualify/mark-lost/reopen) = agency OR client owner OR
 * SETTER; staff refused. Pipeline SETTINGS = agency only (throws Forbidden otherwise). Behavioral
 * harness: real scope, stubbed session + Next boundaries (mirrors campaignsActions.test.ts).
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

const { qualifyOpportunityAction, unqualifyOpportunityAction, markOpportunityLostAction, reopenOpportunityAction, setPipelineSettingsAction } = await import('../../web/lib/pipelineActions.js');
after(closeDb);

const one = async <T>(sql: string, params: unknown[]): Promise<T> => (await query<T>(sql, params)).rows[0];
type S = Awaited<ReturnType<typeof seedScenario>>;
const contact = (s: S, clientId = s.clientId) => seedContact(s.tenantId, clientId, { channelUserId: `wa:${randomUUID().slice(0, 8)}` });
async function seedOpp(s: S, o: { contactId: string; clientId?: string; stage?: string; status?: string; closedAgoDays?: number; lostReason?: string | null }): Promise<string> {
  const r = await one<{ id: string }>(
    `INSERT INTO opportunities (tenant_id, client_id, contact_id, status, stage, lead_at, booked_at, closed_at, lost_reason)
       VALUES ($1,$2,$3,$4,$5, now(),
         CASE WHEN $5 IN ('booked','attended','paid') THEN now() ELSE NULL END,
         CASE WHEN $4 = 'open' THEN NULL ELSE now() - make_interval(days => $6::int) END, $7)
     RETURNING id`,
    [s.tenantId, o.clientId ?? s.clientId, o.contactId, o.status ?? 'open', o.stage ?? 'lead', o.closedAgoDays ?? 0, o.lostReason ?? null],
  );
  return r.id;
}
const stageOf = (s: S, id: string) => one<{ stage: string; status: string }>(`SELECT stage, status FROM opportunities WHERE id = $1`, [id]);

/** A client STAFF member — needs a site/staff binding (the client_role CHECK), so seed it directly. */
async function seedStaffMember(s: S): Promise<string> {
  const userId = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`, [userId, `S ${userId.slice(0, 6)}`, `${userId.slice(0, 8)}@test.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
       VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
    [s.tenantId, userId, s.clientId, s.siteId, s.staffA],
  );
  return userId;
}

test('PL-2 permission matrix: qualify = agency ✓ / owner ✓ / setter ✓ / staff ✗', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const roles: Array<[string, boolean]> = [
      [await seedMember(s.tenantId, { role: 'owner' }), true],
      [await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' }), true],
      [await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' }), true],
      [await seedStaffMember(s), false],
    ];
    for (const [uid, expectOk] of roles) {
      const opp = await seedOpp(s, { contactId: await contact(s), stage: 'lead' });
      asUser(uid);
      const r = await qualifyOpportunityAction(s.clientId, opp, { service: 'Corte', timeframe: 'esta semana' });
      assert.equal(r.ok, expectOk, `qualify ok=${expectOk} for ${uid.slice(0, 6)}`);
      assert.equal((await stageOf(s, opp)).stage, expectOk ? 'qualified' : 'lead');
    }
  } finally { await cleanupTenant(s.tenantId); }
});

test('PL-2: settings are agency only (owner/setter throw Forbidden)', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    asUser(agency);
    assert.equal((await setPipelineSettingsAction(s.clientId, { autoLostAfterHours: 48, reopenWindowDays: 15 })).ok, true);
    assert.equal((await setPipelineSettingsAction(s.clientId, { autoLostAfterHours: 0 })).ok, false, 'below 1 refused');
    assert.equal((await setPipelineSettingsAction(s.clientId, { reopenWindowDays: 999 })).ok, false, 'above 365 refused');
    asUser(owner);
    await assert.rejects(() => setPipelineSettingsAction(s.clientId, { autoLostAfterHours: 24 }), /Forbidden/);
    asUser(setter);
    await assert.rejects(() => setPipelineSettingsAction(s.clientId, { autoLostAfterHours: 24 }), /Forbidden/);
  } finally { await cleanupTenant(s.tenantId); }
});

test('PL-2: qualify requires evidence; mark-lost otro requires a note', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    asUser(setter);
    const opp = await seedOpp(s, { contactId: await contact(s), stage: 'lead' });
    assert.equal((await qualifyOpportunityAction(s.clientId, opp, { service: '', timeframe: 'hoy' })).ok, false, 'no service → refused');
    assert.equal((await qualifyOpportunityAction(s.clientId, opp, { service: 'Corte', timeframe: '' })).ok, false, 'no timeframe → refused');
    assert.equal((await stageOf(s, opp)).stage, 'lead', 'still a lead');

    const opp2 = await seedOpp(s, { contactId: await contact(s), stage: 'qualified' });
    assert.equal((await markOpportunityLostAction(s.clientId, opp2, { reason: 'otro', note: '' })).ok, false, 'otro without a note → refused');
    assert.equal((await markOpportunityLostAction(s.clientId, opp2, { reason: 'otro', note: 'duplicado' })).ok, true, 'otro with a note → ok');
    assert.equal((await stageOf(s, opp2)).status, 'lost');
  } finally { await cleanupTenant(s.tenantId); }
});

test('PL-2: no manual move into booked/attended — qualify on a booked opp is refused', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    asUser(setter);
    const booked = await seedOpp(s, { contactId: await contact(s), stage: 'booked' });
    const r = await qualifyOpportunityAction(s.clientId, booked, { service: 'Corte', timeframe: 'hoy' });
    assert.equal(r.ok, false, 'cannot qualify a booked sale (Reservó is a fact, not a manual move)');
    assert.equal((await stageOf(s, booked)).stage, 'booked');
  } finally { await cleanupTenant(s.tenantId); }
});

test('PL-2: reopen only within the reopen window', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    asUser(setter);
    const fresh = await seedOpp(s, { contactId: await contact(s), stage: 'qualified', status: 'lost', lostReason: 'no_respondio', closedAgoDays: 5 });
    assert.equal((await reopenOpportunityAction(s.clientId, fresh)).ok, true, 'within 30 days → reopens');
    assert.equal((await stageOf(s, fresh)).status, 'open');

    const stale = await seedOpp(s, { contactId: await contact(s), stage: 'lead', status: 'lost', lostReason: 'no_respondio', closedAgoDays: 40 });
    const r = await reopenOpportunityAction(s.clientId, stale);
    assert.equal(r.ok, false, 'past 30 days → refused');
    assert.match(r.ok ? '' : r.error, /ventana/i, 'explains why');
    assert.equal((await stageOf(s, stale)).status, 'lost');
  } finally { await cleanupTenant(s.tenantId); }
});

test('PL-2: isolation — a setter cannot act on another client\'s opportunity', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const other = await seedOpp(s, { contactId: await contact(s, s.otherClientId), clientId: s.otherClientId, stage: 'lead' });
    asUser(setter);
    assert.equal((await qualifyOpportunityAction(s.otherClientId, other, { service: 'X', timeframe: 'y' })).ok, false, 'cross-client refused');
    assert.equal((await stageOf(s, other)).stage, 'lead');
  } finally { await cleanupTenant(s.tenantId); }
});
