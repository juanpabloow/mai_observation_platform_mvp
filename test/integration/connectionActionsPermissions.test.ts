import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * MF-1 item 4 — connection server actions are AGENCY-ONLY.
 *
 * BEHAVIORAL: the real actions run against a real seeded tenant_members scope; only the
 * session-cookie read and the Next request boundaries are stubbed (same technique as
 * timeOffPermissions.test.ts). A client member — even a Client Owner, the highest
 * within-client role — must be refused by requireFullAccessForAction at the data layer,
 * not merely hidden in the UI.
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
    redirect: () => { throw new Error('unexpected redirect() in a behavioral test'); },
    notFound: () => { throw new Error('unexpected notFound() in a behavioral test'); },
  },
});
mock.module(urlOf('next/headers'), {
  namedExports: {
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined, getAll: () => [] }),
  },
});
mock.module(urlOf('next/cache'), {
  namedExports: { revalidatePath: () => {}, revalidateTag: () => {} },
});
const asUser = (userId: string) => { CURRENT = { id: userId, email: `${userId.slice(0, 8)}@test.local` }; };

// Imported AFTER the mock so the action's session read is the stub.
const { addConnectionAction, setConnectionActiveAction } = await import('../../web/lib/connectionActions.js');

after(closeDb);

test('item 4: a Client Owner (client member) is refused on both connection actions', async () => {
  const s = await seedScenario();
  try {
    // A client member with the strongest within-client role — still NOT agency access.
    const clientOwner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    asUser(clientOwner);

    await assert.rejects(
      () => addConnectionAction({ name: 'x', baseUrl: 'https://n8n.local', apiKey: 'k' }),
      /Forbidden/,
      'addConnectionAction must refuse a client member',
    );
    await assert.rejects(
      () => setConnectionActiveAction({ id: '00000000-0000-0000-0000-000000000000', isActive: false }),
      /Forbidden/,
      'setConnectionActiveAction must refuse a client member',
    );
    // The gate runs BEFORE any write: no connection was created by the refused call.
    assert.equal(
      (await query('SELECT count(*)::int n FROM n8n_connections WHERE tenant_id=$1', [s.tenantId])).rows[0].n,
      0,
      'refused action wrote nothing',
    );
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('item 4: an agency Owner passes the gate (setConnectionActiveAction succeeds)', async () => {
  const s = await seedScenario();
  try {
    const agencyOwner = await seedMember(s.tenantId, { role: 'owner' });
    asUser(agencyOwner);
    // A real connection owned by the tenant (pure-DB path, no n8n network call).
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, `wf-${s.tenantId.slice(0, 8)}`);

    const res = await setConnectionActiveAction({ id: connectionId, isActive: false });
    assert.equal(res.ok, true, 'owner may toggle a connection');
    assert.equal(
      (await query('SELECT is_active FROM n8n_connections WHERE id=$1', [connectionId])).rows[0].is_active,
      false,
      'the toggle actually applied',
    );
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
