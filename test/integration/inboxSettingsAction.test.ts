import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { getInboxSettings } from '../../src/db/repositories/inboxSettings.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * JP-2 — the inbox auto-return SETTING is changeable by the AGENCY or the CLIENT OWNER only; a Setter
 * (who can attend conversations) is refused at the data layer. Hit the server action directly.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', { namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) } });
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (id: string) => { CURRENT = { id, email: `${id.slice(0, 8)}@test.local` }; };

const { setInboxAutoReturnMinutesAction } = await import('../../web/lib/inboxSettingsActions.js');
const tenants: string[] = [];
after(async () => { CURRENT = null; for (const t of tenants) await cleanupTenant(t); await closeDb(); });

test('agency and the client owner can change it; a setter cannot; range is validated', async () => {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'inbox', enabled: true });
  const agency = await seedMember(s.tenantId, { role: 'owner' });
  const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
  const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
  const minutes = () => getInboxSettings(s.tenantId, s.clientId).then((x) => x.auto_return_minutes);

  asUser(agency);
  const a = await setInboxAutoReturnMinutesAction(s.clientId, 30);
  assert.deepEqual(a, { ok: true, value: 30 });
  assert.equal(await minutes(), 30);

  asUser(owner);
  assert.deepEqual(await setInboxAutoReturnMinutesAction(s.clientId, 90), { ok: true, value: 90 });
  assert.equal(await minutes(), 90);

  // 0 = never is a legal value.
  asUser(owner);
  assert.deepEqual(await setInboxAutoReturnMinutesAction(s.clientId, 0), { ok: true, value: 0 });

  // A setter is refused; the stored value is untouched.
  asUser(setter);
  const refused = await setInboxAutoReturnMinutesAction(s.clientId, 120);
  assert.equal(refused.ok, false);
  assert.equal(await minutes(), 0);

  // Out-of-range is refused (agency).
  asUser(agency);
  assert.equal((await setInboxAutoReturnMinutesAction(s.clientId, -5)).ok, false);
  assert.equal((await setInboxAutoReturnMinutesAction(s.clientId, 99999)).ok, false);
  assert.equal(await minutes(), 0, 'unchanged by the rejected writes');
});
