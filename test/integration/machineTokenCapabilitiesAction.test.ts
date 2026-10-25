import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * FIX — the machine-token capability editor (web/components/MachineTokens.tsx) through its server
 * actions, with a real scope. Pins: an AGENCY login can toggle a token's capabilities (e.g. add
 * pipeline.write, the one whose checkbox was missing) and it PERSISTS; a non-agency (member) login is
 * REFUSED at the data layer (requireFullAccessForAction throws) and nothing changes.
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

const { issueTokenAction, updateTokenCapabilitiesAction } = await import('../../web/lib/handoffTokenActions.js');
const tenants: string[] = [];
after(async () => { CURRENT = null; for (const t of tenants) await cleanupTenant(t); await closeDb(); });

const capsOf = (id: string) => query<{ capabilities: string[] }>(`SELECT capabilities FROM handoff_tokens WHERE id = $1`, [id]).then((r) => [...r.rows[0].capabilities].sort());

async function scenario() {
  const s = await seedScenario(); tenants.push(s.tenantId);
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, `wf-${s.tenantId.slice(0, 6)}`);
  const agency = await seedMember(s.tenantId, { role: 'owner' });
  const member = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  return { ...s, connectionId, agency, member };
}

test('an agency login toggles a token capability (adds pipeline.write) and it persists', async () => {
  const s = await scenario();
  const { row } = await issueToken(s.tenantId, s.connectionId, ['handoff']);
  asUser(s.agency);

  const r = await updateTokenCapabilitiesAction(row.id, ['handoff', 'pipeline.write']);
  assert.equal(r.ok, true, 'the edit succeeds');
  assert.deepEqual(await capsOf(row.id), ['handoff', 'pipeline.write'], 'pipeline.write persisted');

  // Issuing a fresh token with the chosen set persists it too.
  const issued = await issueTokenAction(s.connectionId, ['handoff', 'catalog.read']);
  assert.ok(issued.ok && issued.rawToken, 'a token is issued');
  const fresh = await query<{ id: string }>(`SELECT id FROM handoff_tokens WHERE tenant_id = $1 AND token_prefix = $2`, [s.tenantId, issued.ok ? issued.prefix : '']);
  assert.deepEqual(await capsOf(fresh.rows[0].id), ['catalog.read', 'handoff'], 'issued with the chosen capabilities');
});

test('a non-agency (member) login is refused and nothing changes', async () => {
  const s = await scenario();
  const { row } = await issueToken(s.tenantId, s.connectionId, ['handoff', 'pipeline.write']);
  asUser(s.member);

  await assert.rejects(updateTokenCapabilitiesAction(row.id, ['handoff']), /Forbidden/, 'a member cannot edit capabilities');
  await assert.rejects(issueTokenAction(s.connectionId, ['handoff']), /Forbidden/, 'a member cannot issue a token');
  assert.deepEqual(await capsOf(row.id), ['handoff', 'pipeline.write'], 'the token is untouched');
});
