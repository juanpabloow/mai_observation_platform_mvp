import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setContactOrigin } from '../../src/db/repositories/attribution.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario } from './fixtures.js';

/** MF-1-style behavioral harness: real scope, stubbed session + Next boundaries. */
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

const { setContactOriginManualAction } = await import('../../web/lib/attributionActions.js');
after(closeDb);
const originOf = async (id: string): Promise<string | null> => (await query<{ origin_kind: string | null }>(`SELECT origin_kind FROM contacts WHERE id=$1`, [id])).rows[0].origin_kind;

test('AT-1 manual: agency sets an unknown contact to manual; a client Owner too; a Setter is refused', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const c1 = await seedContact(s.tenantId, s.clientId, { name: 'C1' });
    const c2 = await seedContact(s.tenantId, s.clientId, { name: 'C2' });

    asUser(agency);
    assert.equal((await setContactOriginManualAction(s.clientId, c1, { note: 'vino por volante' })).ok, true);
    assert.equal(await originOf(c1), 'manual');

    asUser(owner);
    assert.equal((await setContactOriginManualAction(s.clientId, c2, { note: 'referido' })).ok, true);
    assert.equal(await originOf(c2), 'manual');

    asUser(setter);
    const refused = await setContactOriginManualAction(s.clientId, await seedContact(s.tenantId, s.clientId, {}), { note: 'x' });
    assert.equal(refused.ok, false, 'a Setter cannot set origin');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 manual: NEVER overwrites a captured ad origin', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const c = await seedContact(s.tenantId, s.clientId, { name: 'Ad lead' });
    await setContactOrigin({ tenantId: s.tenantId, clientId: s.clientId, contactId: c, originKind: 'meta_ad', setBy: 'system', overwritable: [] });

    asUser(agency);
    const r = await setContactOriginManualAction(s.clientId, c, { note: 'intento' });
    assert.equal(r.ok, false, 'refused — a captured ad origin is immutable');
    assert.equal(await originOf(c), 'meta_ad', 'origin unchanged');
  } finally { await cleanupTenant(s.tenantId); }
});

test('AT-1 manual: a Client Owner of A cannot touch a contact in client B', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const ownerOfA = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const cInB = await seedContact(s.tenantId, s.otherClientId, { name: 'B' });
    asUser(ownerOfA);
    assert.equal((await setContactOriginManualAction(s.otherClientId, cInB, { note: 'x' })).ok, false, 'no cross-client manual origin');
    assert.equal(await originOf(cInB), null, 'unchanged');
  } finally { await cleanupTenant(s.tenantId); }
});
