import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { issueToken } from '../../src/db/repositories/handoffTokens.js';
import { createException } from '../../src/db/repositories/scheduling/exceptions.js';
import { localWallClockToUtc } from '../../src/scheduling/timezone.js';
import { cleanupTenant, closeDb, seedMember, seedScenario, seedSiteForClient, seedWorkflow } from './fixtures.js';

/**
 * BEHAVIORAL permission + reason-exposure tests — the real server actions and machine routes,
 * not source contracts. The ONLY thing stubbed is the session-cookie read (`getServerSession`,
 * the Next request boundary that can't exist in a test); everything else runs for real:
 * getAccessScope → getMembershipForUser (a REAL seeded tenant_members row) → the real access
 * predicates → the real action → the real DB. React `cache` does not memoize outside a request,
 * so switching the mocked user between calls re-resolves the scope each time.
 */

let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: {
    getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null),
  },
});
// The node:test module-mock loader resolves modules via CJS, which drops Next's `react-server`
// export condition — so the real next/navigation|headers|cache would pull in the CLIENT build
// (React.createContext, absent under react-server). Our code paths never call redirect/notFound
// (valid scopes, graceful refusals) and revalidatePath is a no-op in a test, so stubbing these
// Next boundaries is both safe and necessary.
// `next` lives in web/node_modules, so resolve these from a web-local base, then mock by the
// resolved URL (a bare "next/navigation" specifier can't be resolved from this test's dir).
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
const asUser = (userId: string) => {
  CURRENT = { id: userId, email: `${userId.slice(0, 8)}@test.local` };
};

// Imported AFTER the mock is registered so the action's session read is the stub.
const { createTimeOffAction, updateTimeOffAction, deleteTimeOffAction } = await import('../../web/lib/timeOffActions.js');
const { updateStaffAction, deactivateStaffAction } = await import('../../web/lib/schedulingAdminActions.js');

const TZ = 'America/Bogota';
const createdUsers: string[] = [];

/** A STAFF login: a tenant_members row bound to a staff resource by id. */
async function seedStaffLogin(tenantId: string, clientId: string, siteId: string, staffId: string): Promise<string> {
  const userId = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Staff', $2, true)`, [userId, `staff-${userId.slice(0, 8)}@test.local`]);
  await query(
    `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
       VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
    [tenantId, userId, clientId, siteId, staffId],
  );
  createdUsers.push(userId);
  return userId;
}

const full = (startDate: string, endDate = startDate) => ({ mode: 'full_day' as const, startDate, endDate });
const isRefused = (r: { ok: boolean }) => r.ok === false && !('conflicts' in r);

test('time off: Setter manages STAFF time off, is refused on SITE closures', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    createdUsers.push(setter, owner);

    asUser(setter);
    // CREATE a staff block → ok.
    const created = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, reason: 'Falla', ...full('2026-11-10') });
    assert.equal(created.ok, true, 'setter creates staff time off');
    const blockId = created.ok ? created.id : '';
    // EDIT it → ok.
    assert.equal((await updateTimeOffAction(s.clientId, blockId, full('2026-11-11'))).ok, true, 'setter edits staff time off');
    // CREATE a SITE closure → refused.
    assert.ok(isRefused(await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: null, ...full('2026-11-12') })), 'setter cannot create a site closure');

    // An owner makes a real site closure; the setter may NOT edit or delete it.
    asUser(owner);
    const closure = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: null, reason: 'Festivo', ...full('2026-11-13') });
    assert.equal(closure.ok, true);
    const closureId = closure.ok ? closure.id : '';
    asUser(setter);
    assert.ok(isRefused(await updateTimeOffAction(s.clientId, closureId, full('2026-11-14'))), 'setter cannot edit a site closure');
    assert.ok(isRefused(await deleteTimeOffAction(s.clientId, closureId)), 'setter cannot delete a site closure');
    // DELETE its own staff block → ok.
    assert.equal((await deleteTimeOffAction(s.clientId, blockId)).ok, true, 'setter deletes staff time off');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('time off: a Staff login is refused on every create/edit/delete, incl. another staff and site closures', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    createdUsers.push(owner);
    const staffLogin = await seedStaffLogin(s.tenantId, s.clientId, s.siteId, s.staffA);

    // Owner seeds a block for Ana (staffA) and a block for Beto (staffB) + a site closure.
    asUser(owner);
    const own = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, ...full('2026-11-10') });
    const other = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffB, ...full('2026-11-10') });
    const closure = await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: null, ...full('2026-11-11') });
    assert.ok(own.ok && other.ok && closure.ok);

    asUser(staffLogin);
    // Create (even for themselves) → refused.
    assert.ok(isRefused(await createTimeOffAction({ clientId: s.clientId, siteId: s.siteId, staffId: s.staffA, ...full('2026-11-12') })), 'staff cannot create time off');
    // Edit/delete OWN block → refused.
    assert.ok(isRefused(await updateTimeOffAction(s.clientId, own.ok ? own.id : '', full('2026-11-13'))), 'staff cannot edit even its own block');
    assert.ok(isRefused(await deleteTimeOffAction(s.clientId, own.ok ? own.id : '')), 'staff cannot delete even its own block');
    // Another staff member's block id → refused.
    assert.ok(isRefused(await updateTimeOffAction(s.clientId, other.ok ? other.id : '', full('2026-11-13'))), "staff cannot touch another staff's block");
    assert.ok(isRefused(await deleteTimeOffAction(s.clientId, other.ok ? other.id : '')), "staff cannot delete another staff's block");
    // Site closure → refused.
    assert.ok(isRefused(await deleteTimeOffAction(s.clientId, closure.ok ? closure.id : '')), 'staff cannot delete a site closure');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('time off: Client Owner of A is refused on every time-off action for client B', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const b = await seedSiteForClient(s.tenantId, s.otherClientId);
    const ownerA = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    const ownerB = await seedMember(s.tenantId, { role: 'member', clientId: s.otherClientId, clientRole: 'owner' });
    createdUsers.push(ownerA, ownerB);

    // Owner B makes a real block on B.
    asUser(ownerB);
    const bBlock = await createTimeOffAction({ clientId: s.otherClientId, siteId: b.siteId, staffId: b.staffId, ...full('2026-11-10') });
    assert.equal(bBlock.ok, true);

    // Owner A cannot create, edit, or delete anything for client B.
    asUser(ownerA);
    assert.ok(isRefused(await createTimeOffAction({ clientId: s.otherClientId, siteId: b.siteId, staffId: null, ...full('2026-11-11') })), 'owner A cannot create for B');
    assert.ok(isRefused(await updateTimeOffAction(s.otherClientId, bBlock.ok ? bBlock.id : '', full('2026-11-12'))), "owner A cannot edit B's block");
    assert.ok(isRefused(await deleteTimeOffAction(s.otherClientId, bBlock.ok ? bBlock.id : '')), "owner A cannot delete B's block");
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('staff edit: Setter and Staff are refused on update + deactivate; Owner succeeds', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const setter = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'setter' });
    const owner = await seedMember(s.tenantId, { role: 'member', clientId: s.clientId, clientRole: 'owner' });
    createdUsers.push(setter, owner);
    const staffLogin = await seedStaffLogin(s.tenantId, s.clientId, s.siteId, s.staffA);

    for (const u of [setter, staffLogin]) {
      asUser(u);
      assert.equal((await updateStaffAction(s.clientId, s.staffA, { name: 'Renamed' })).ok, false, 'edit refused');
      assert.equal((await deactivateStaffAction(s.clientId, s.staffA)).ok, false, 'deactivate refused');
    }
    // Owner can.
    asUser(owner);
    assert.equal((await updateStaffAction(s.clientId, s.staffA, { title: 'Senior' })).ok, true, 'owner edits');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('machine API never exposes the block reason (availability, staff, appointments)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    // A reasoned STAFF block and a reasoned SITE closure.
    await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: s.staffA, startsAt: localWallClockToUtc('2026-11-02T14:00', TZ), endsAt: localWallClockToUtc('2026-11-02T16:00', TZ), reason: 'Vacaciones' });
    await createException({ tenantId: s.tenantId, siteId: s.siteId, staffId: null, startsAt: localWallClockToUtc('2026-11-03T00:00', TZ), endsAt: localWallClockToUtc('2026-11-04T00:00', TZ), reason: 'Festivo' });

    const wfRef = `wf-${s.tenantId.slice(0, 6)}`;
    const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, wfRef);
    const { rawToken } = await issueToken(s.tenantId, connectionId, ['scheduling.read']);
    const hdr = { Authorization: `Bearer ${rawToken}`, 'x-workflow-ref': wfRef };

    const [{ GET: AvailGET }, { GET: StaffGET }, { GET: ApptGET }] = await Promise.all([
      import('../../web/app/api/scheduling/v1/availability/route.js'),
      import('../../web/app/api/scheduling/v1/staff/route.js'),
      import('../../web/app/api/scheduling/v1/appointments/route.js'),
    ]);

    const from = localWallClockToUtc('2026-11-02T00:00', TZ).toISOString();
    const to = localWallClockToUtc('2026-11-05T00:00', TZ).toISOString();
    const bodies = await Promise.all([
      AvailGET(new Request(`http://t/api/scheduling/v1/availability?site_id=${s.siteId}&service_id=${s.serviceHaircut}&from=${from}&to=${to}`, { headers: hdr })).then((r) => r.text()),
      StaffGET(new Request(`http://t/api/scheduling/v1/staff?site_id=${s.siteId}`, { headers: hdr })).then((r) => r.text()),
      ApptGET(new Request(`http://t/api/scheduling/v1/appointments`, { headers: hdr })).then((r) => r.text()),
    ]);

    for (const [i, body] of bodies.entries()) {
      assert.ok(!body.includes('Vacaciones'), `response ${i} leaks the staff-block reason`);
      assert.ok(!body.includes('Festivo'), `response ${i} leaks the site-closure reason`);
      assert.ok(!/"reason"/.test(body), `response ${i} carries no reason field`);
    }
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

after(async () => {
  // Clean up the login rows (not tenant-cascaded) BEFORE closing the pool.
  if (createdUsers.length) await query(`DELETE FROM "user" WHERE id = ANY($1::text[])`, [createdUsers]);
  await closeDb();
});
