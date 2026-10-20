import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { setClientModuleEnabled } from '../../src/db/repositories/clientModules.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';

/**
 * REUNIONES ACCESS POLICY (decided 2026-10-20): the agency and THIS client's owner only.
 * Recepción (setter) — which the sidebar already hid it from — and staff get the same
 * indistinguishable not_found as a stranger, at the ONE gate every session-authed meetings
 * API route goes through (`resolveAppScope`). Against a real local test database; only the
 * session read and Next's boundaries are stubbed.
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: {
    getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null),
  },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), {
  namedExports: {
    redirect: (url: string) => { throw new Error(`redirect ${url}`); },
    notFound: () => { throw new Error('404'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('server-only'), { namedExports: {} });
const asUser = (userId: string | null) => { CURRENT = userId ? { id: userId, email: `${userId.slice(0, 8)}@test.local` } : null; };

const { resolveAppScope } = await import('../../web/lib/meetingsAppScope.js');
const { canAccessMeetings } = await import('../../web/lib/access.js');

after(closeDb);

const outcome = async (clientId: string) => {
  try {
    const r = await resolveAppScope(clientId);
    return r.clientId === clientId ? 'ok' : 'wrong-client';
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

test('Reuniones: agency and own owner pass; recepción, staff, another owner and another tenant get not_found', async () => {
  const s = await seedScenario();
  const other = await seedScenario();
  try {
    await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'meetings', enabled: true });
    const agency = await seedMember(s.tenantId, { role: 'owner' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const ownerOfB = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
    const foreignAgency = await seedMember(other.tenantId, { role: 'owner' });
    const staffUser = randomUUID();
    await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Staff', $2, true)`, [staffUser, `${staffUser.slice(0, 8)}@test.local`]);
    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id) VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
      [s.tenantId, staffUser, s.clientId, s.siteId, s.staffA],
    );

    asUser(agency);
    assert.equal(await outcome(s.clientId), 'ok', 'agency');
    asUser(owner);
    assert.equal(await outcome(s.clientId), 'ok', 'this client\'s owner');
    for (const [who, id] of [['recepción (setter)', setter], ['staff', staffUser], ['owner of B', ownerOfB], ['foreign agency', foreignAgency]] as const) {
      asUser(id);
      assert.equal(await outcome(s.clientId), 'not_found', `${who} is refused like a stranger`);
    }
    // The same rule, as the pure capability the pages use.
    assert.equal(canAccessMeetings({ tenantId: s.tenantId, userId: setter, role: 'member', memberClientId: s.clientId, clientRole: 'setter' } as never, s.clientId), false);
    assert.equal(canAccessMeetings({ tenantId: s.tenantId, userId: owner, role: 'member', memberClientId: s.clientId, clientRole: 'owner' } as never, s.clientId), true);
    // Module off → not_found even for the agency (unchanged).
    await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'meetings', enabled: false });
    asUser(agency);
    assert.equal(await outcome(s.clientId), 'not_found', 'module off');
  } finally {
    await cleanupTenant(s.tenantId);
    await cleanupTenant(other.tenantId);
  }
});
