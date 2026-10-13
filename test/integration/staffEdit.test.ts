import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  activeStaffNameTaken,
  createStaff,
  deactivateStaff,
  listStaff,
  updateStaff,
} from '../../src/db/repositories/scheduling/staff.js';
import { listAppointments } from '../../src/db/repositories/scheduling/appointments.js';
import { createAppointment } from '../../src/scheduling/booking.js';
import { localWallClockToUtc } from '../../src/scheduling/timezone.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

after(closeDb);

const TZ = 'America/Bogota';

test('staff rename propagates everywhere (staff referenced by id, no name snapshot)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const appt = await createAppointment({
      tenantId: s.tenantId,
      siteId: s.siteId,
      serviceId: s.serviceHaircut,
      staffId: s.staffA,
      startAt: localWallClockToUtc('2026-11-02T10:00', TZ),
      origin: 'internal',
      createdByType: 'agent',
      scopeClientId: s.clientId,
      now: localWallClockToUtc('2026-11-02T00:00', TZ),
    });
    assert.equal(appt.ok, true);

    // Rename Ana → "Ana María".
    const row = await updateStaff(s.tenantId, s.staffA, { name: 'Ana María' });
    assert.equal(row?.name, 'Ana María');

    // The bot/agenda staff list reads the live name by id.
    const roster = await listStaff(s.tenantId, { siteId: s.siteId, clientId: s.clientId });
    assert.equal(roster.find((x) => x.id === s.staffA)?.name, 'Ana María');

    // The existing appointment now shows the new name (joined by id — no stale snapshot).
    const appts = await listAppointments(s.tenantId, { siteId: s.siteId, clientId: s.clientId });
    assert.equal(appts.find((a) => a.staff_id === s.staffA)?.staff_name, 'Ana María');
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('staff name uniqueness binds ACTIVE staff per site, case-insensitively', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    const zoe = await createStaff({ tenantId: s.tenantId, siteId: s.siteId, name: 'Zoe' });
    // Another ACTIVE staff with the same folded name at the SAME site → taken.
    assert.equal(await activeStaffNameTaken(s.tenantId, s.siteId, 'zoe'), true);
    assert.equal(await activeStaffNameTaken(s.tenantId, s.siteId, '  ZOE '), true);
    // Excluding the holder (a no-op rename) → not taken.
    assert.equal(await activeStaffNameTaken(s.tenantId, s.siteId, 'Zoe', zoe.id), false);
    // A different site may reuse the name.
    const other = await query<{ id: string }>(
      `INSERT INTO sites (tenant_id, client_id, slug, name, timezone, opening_hours, scheduling_config)
         VALUES ($1,$2,$3,'Site 2','America/Bogota','{}'::jsonb,'{}'::jsonb) RETURNING id`,
      [s.tenantId, s.clientId, `s2-${s.tenantId.slice(0, 8)}`],
    );
    assert.equal(await activeStaffNameTaken(s.tenantId, other.rows[0].id, 'Zoe'), false);
    // Deactivating frees the name (only ACTIVE staff collide).
    assert.equal(await deactivateStaff(s.tenantId, zoe.id), true);
    assert.equal(await activeStaffNameTaken(s.tenantId, s.siteId, 'Zoe'), false);
  } finally {
    await cleanupTenant(s.tenantId);
  }
});

test('editing staff.email is CONTACT data only — the linked user login is untouched', async () => {
  const s = await seedScenario({ enableScheduling: true });
  try {
    // A real staff login: a tenant_members row bound to staffA by id (not by email). The
    // login email is unique per run ("user".email is global) and cleaned up below, since
    // the user row isn't tenant-cascaded.
    const userId = randomUUID();
    const loginEmailValue = `login-${userId.slice(0, 8)}@identity.test`;
    await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Ana', $2, true)`, [userId, loginEmailValue]);
    await query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role, scheduling_site_id, scheduling_staff_id)
         VALUES ($1, $2, 'member', $3, 'staff', $4, $5)`,
      [s.tenantId, userId, s.clientId, s.siteId, s.staffA],
    );

    try {
      // Edit the staff CONTACT email.
      await updateStaff(s.tenantId, s.staffA, { email: 'contact@shop.test' });

      const staffEmail = (await query<{ email: string | null }>(`SELECT email FROM staff WHERE id = $1`, [s.staffA])).rows[0].email;
      const loginEmail = (await query<{ email: string }>(`SELECT email FROM "user" WHERE id = $1`, [userId])).rows[0].email;
      assert.equal(staffEmail, 'contact@shop.test', 'the staff contact email changed');
      assert.equal(loginEmail, loginEmailValue, 'the login identity is UNCHANGED');
    } finally {
      await query(`DELETE FROM "user" WHERE id = $1`, [userId]);
    }
  } finally {
    await cleanupTenant(s.tenantId);
  }
});
