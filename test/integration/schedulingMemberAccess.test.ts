import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  getMembershipForUser,
  setMemberSchedulingAccess,
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

test('staff/reception grants are tenant-client-site safe and invitations copy them atomically', async () => {
  const scenario = await seedScenario({ enableScheduling: true });
  try {
    const staffUser = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });
    const receptionUser = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });

    assert.equal(await setMemberSchedulingAccess({
      tenantId: scenario.tenantId,
      userId: staffUser,
      clientId: scenario.clientId,
      access: 'staff',
      siteId: scenario.siteId,
      staffId: scenario.staffA,
    }), 1);
    assert.deepEqual(
      await getMembershipForUser(staffUser),
      {
        tenant_id: scenario.tenantId,
        role: 'member',
        member_client_id: scenario.clientId,
        scheduling_access: 'staff',
        scheduling_site_id: scenario.siteId,
        scheduling_staff_id: scenario.staffA,
      },
    );

    assert.equal(await setMemberSchedulingAccess({
      tenantId: scenario.tenantId,
      userId: receptionUser,
      clientId: scenario.clientId,
      access: 'reception',
      siteId: scenario.siteId,
    }), 1);

    const duplicateUser = await seedMember(scenario.tenantId, { role: 'member', clientId: scenario.clientId });
    await assert.rejects(
      setMemberSchedulingAccess({
        tenantId: scenario.tenantId,
        userId: duplicateUser,
        clientId: scenario.clientId,
        access: 'staff',
        siteId: scenario.siteId,
        staffId: scenario.staffA,
      }),
      (error: unknown) => (error as { code?: string }).code === '23505',
    );

    const foreign = await seedSiteForClient(scenario.tenantId, scenario.otherClientId);
    await assert.rejects(
      setMemberSchedulingAccess({
        tenantId: scenario.tenantId,
        userId: duplicateUser,
        clientId: scenario.clientId,
        access: 'staff',
        siteId: foreign.siteId,
        staffId: foreign.staffId,
      }),
      (error: unknown) => ['23503', '23514'].includes((error as { code?: string }).code ?? ''),
    );

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
      schedulingAccess: 'staff',
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
    assert.equal(accepted?.scheduling_access, 'staff');
    assert.equal(accepted?.scheduling_site_id, scenario.siteId);
    assert.equal(accepted?.scheduling_staff_id, scenario.staffB);
  } finally {
    await cleanupTenant(scenario.tenantId);
  }
});
