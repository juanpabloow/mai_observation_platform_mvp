import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  countClientOwners,
  getMembershipForUser,
  setMemberClientRole,
} from '../../src/db/repositories/tenantMembers.js';
import {
  acceptInvitation,
  createOrReplacePendingInvitation,
} from '../../src/db/repositories/invitations.js';
import {
  cleanupTenant,
  closeDb,
  seedMember,
  seedScenario,
  seedSiteForClient,
} from './fixtures.js';

after(closeDb);

test('client roles: staff/editor grants are tenant-client-site safe and invitations copy them atomically', async () => {
  const scenario = await seedScenario({ enableScheduling: true });
  try {
    const staffUser = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });
    const editorUser = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });

    // STAFF → bound to one site + one staff resource.
    assert.equal(await setMemberClientRole({
      tenantId: scenario.tenantId,
      userId: staffUser,
      clientId: scenario.clientId,
      clientRole: 'staff',
      siteId: scenario.siteId,
      staffId: scenario.staffA,
    }), 1);
    assert.deepEqual(await getMembershipForUser(staffUser), {
      tenant_id: scenario.tenantId,
      role: 'member',
      member_client_id: scenario.clientId,
      client_role: 'staff',
      scheduling_site_id: scenario.siteId,
      scheduling_staff_id: scenario.staffA,
    });

    // EDITOR → whole client, no site/staff binding.
    assert.equal(await setMemberClientRole({
      tenantId: scenario.tenantId,
      userId: editorUser,
      clientId: scenario.clientId,
      clientRole: 'editor',
    }), 1);
    assert.deepEqual(await getMembershipForUser(editorUser), {
      tenant_id: scenario.tenantId,
      role: 'member',
      member_client_id: scenario.clientId,
      client_role: 'editor',
      scheduling_site_id: null,
      scheduling_staff_id: null,
    });

    // ONE login per staff resource (partial unique index).
    const duplicateUser = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });
    await assert.rejects(
      setMemberClientRole({
        tenantId: scenario.tenantId,
        userId: duplicateUser,
        clientId: scenario.clientId,
        clientRole: 'staff',
        siteId: scenario.siteId,
        staffId: scenario.staffA,
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );

    // A site/staff from ANOTHER client can't be bound (composite FK / CHECK).
    const foreign = await seedSiteForClient(scenario.tenantId, scenario.otherClientId);
    await assert.rejects(
      setMemberClientRole({
        tenantId: scenario.tenantId,
        userId: duplicateUser,
        clientId: scenario.clientId,
        clientRole: 'staff',
        siteId: foreign.siteId,
        staffId: foreign.staffId,
      }),
      (error: unknown) => ['23503', '23514'].includes((error as { code?: string }).code ?? ''),
    );

    // An invitation snapshots the client role + binding and accept copies it atomically.
    const inviter = await seedMember(scenario.tenantId, { role: 'owner' });
    const invitedUser = randomUUID();
    const invitedEmail = `${invitedUser.slice(0, 8)}@test.local`;
    await query(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ($1, 'Invited staff', $2, true)`,
      [invitedUser, invitedEmail],
    );
    const invitation = await createOrReplacePendingInvitation({
      tenantId: scenario.tenantId,
      email: invitedEmail,
      role: 'member',
      memberClientId: scenario.clientId,
      clientRole: 'staff',
      schedulingSiteId: scenario.siteId,
      schedulingStaffId: scenario.staffB,
      tokenHash: randomUUID().replaceAll('-', ''),
      invitedBy: inviter,
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal(await acceptInvitation({
      invitationId: invitation.id,
      tenantId: scenario.tenantId,
      userId: invitedUser,
    }), 'accepted');
    const accepted = await getMembershipForUser(invitedUser);
    assert.equal(accepted?.client_role, 'staff');
    assert.equal(accepted?.scheduling_site_id, scenario.siteId);
    assert.equal(accepted?.scheduling_staff_id, scenario.staffB);
  } finally {
    await cleanupTenant(scenario.tenantId);
  }
});

test('countClientOwners powers the last-owner guard', async () => {
  const scenario = await seedScenario({ enableScheduling: true });
  try {
    // A fresh editor member — no client owners yet.
    const editor = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });
    assert.equal(await countClientOwners(scenario.tenantId, scenario.clientId), 0);

    // Promote to owner → exactly one.
    await setMemberClientRole({
      tenantId: scenario.tenantId,
      userId: editor,
      clientId: scenario.clientId,
      clientRole: 'owner',
    });
    assert.equal(await countClientOwners(scenario.tenantId, scenario.clientId), 1);

    // A second owner → two; scoped to THIS client only.
    const other = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });
    await setMemberClientRole({
      tenantId: scenario.tenantId,
      userId: other,
      clientId: scenario.clientId,
      clientRole: 'owner',
    });
    assert.equal(await countClientOwners(scenario.tenantId, scenario.clientId), 2);
    assert.equal(await countClientOwners(scenario.tenantId, scenario.otherClientId), 0);
  } finally {
    await cleanupTenant(scenario.tenantId);
  }
});
