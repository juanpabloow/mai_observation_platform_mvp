import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { cleanupTenant, closeDb, seedContact, seedMember, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * MF-1 item 6 — stage_changed / owner_changed are recorded in ONE place (updateContact,
 * the repository write path), so a change leaves identical history whether it comes from
 * the web action or the machine API, and the machine PATCH records it exactly once (no
 * route-level duplicate).
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
  namedExports: { redirect: () => { throw new Error('unexpected redirect()'); }, notFound: () => { throw new Error('unexpected notFound()'); } },
});
mock.module(urlOf('next/headers'), {
  namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) },
});
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });
const asUser = (userId: string) => { CURRENT = { id: userId, email: `${userId.slice(0, 8)}@test.local` }; };

const { updateContactAction } = await import('../../web/lib/contactActions.js');
const { PATCH } = await import('../../web/app/api/crm/v1/contacts/[contactId]/route.js');

after(closeDb);

interface Ev { event_type: string; actor_kind: string; actor_user_id: string | null; f: string | null; t: string | null; }
async function events(contactId: string, type: string): Promise<Ev[]> {
  return (await query<Ev>(
    `SELECT event_type, actor_kind, actor_user_id, detail->>'from' AS f, detail->>'to' AS t
       FROM crm_activity_events WHERE contact_id=$1 AND event_type=$2`, [contactId, type])).rows;
}

test('item 6: a web-action stage change records exactly one stage_changed (actor=user)', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const owner = await seedMember(s.tenantId, { role: 'owner' });
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead' }); // stage defaults to 'new'
    asUser(owner);

    const res = await updateContactAction(s.clientId, contact, { stage: 'active' });
    assert.equal(res.ok, true);
    const evs = await events(contact, 'stage_changed');
    assert.equal(evs.length, 1, 'exactly one stage_changed');
    assert.deepEqual({ f: evs[0].f, t: evs[0].t }, { f: 'new', t: 'active' }, 'from/to recorded');
    assert.equal(evs[0].actor_kind, 'user');
    assert.equal(evs[0].actor_user_id, owner, 'attributed to the acting user');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('item 6: a web-action owner change records exactly one owner_changed (actor=user, from/to)', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const owner = await seedMember(s.tenantId, { role: 'owner' });
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead' }); // assigned_to defaults null
    asUser(owner);

    const res = await updateContactAction(s.clientId, contact, { assigned_to: owner });
    assert.equal(res.ok, true);
    const evs = await events(contact, 'owner_changed');
    assert.equal(evs.length, 1, 'exactly one owner_changed');
    assert.deepEqual({ f: evs[0].f, t: evs[0].t }, { f: null, t: owner }, 'from null → owner');
    assert.equal(evs[0].actor_kind, 'user');
    assert.equal(evs[0].actor_user_id, owner);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('item 6: a machine-API stage change records exactly one stage_changed (actor=automation, no duplicate)', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead' }); // stage 'new'
    const wfRef = `wf-${s.tenantId.slice(0, 8)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['crm.write']);

    const res = await PATCH(
      new Request(`http://t/api/crm/v1/contacts/${contact}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef, 'content-type': 'application/json' },
        body: JSON.stringify({ stage: 'active' }),
      }),
      { params: Promise.resolve({ contactId: contact }) },
    );
    assert.equal(res.status, 200);
    const evs = await events(contact, 'stage_changed');
    assert.equal(evs.length, 1, 'exactly one stage_changed — the route no longer double-writes');
    assert.deepEqual({ f: evs[0].f, t: evs[0].t }, { f: 'new', t: 'active' });
    assert.equal(evs[0].actor_kind, 'automation');
    assert.equal(evs[0].actor_user_id, null);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('item 6: a no-op stage write records no event', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const owner = await seedMember(s.tenantId, { role: 'owner' });
    const contact = await seedContact(s.tenantId, s.clientId, { name: 'Lead' }); // already 'new'
    asUser(owner);
    const res = await updateContactAction(s.clientId, contact, { stage: 'new' });
    assert.equal(res.ok, true);
    assert.equal((await events(contact, 'stage_changed')).length, 0, 'same-value stage change is not an event');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
