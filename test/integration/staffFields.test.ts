import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  getStaffById,
  getStaffByIdAdmin,
  listStaff,
  listStaffAdmin,
  updateStaff,
} from '../../src/db/repositories/scheduling/staff.js';
import {
  createStaffCertification,
  deleteStaffCertification,
  listStaffCertifications,
} from '../../src/db/repositories/scheduling/staffCertifications.js';
import { createService, listServices, updateService } from '../../src/db/repositories/scheduling/services.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * The 1783200000000 staff-fields migration, proven against PostgreSQL: the profile
 * columns round-trip, the PII boundary holds at RUNTIME (not just in the source
 * contract), the CHECK constraints reject bad data, and certifications cannot cross a
 * tenant. Nothing here asserts on the UI — this branch does not touch it.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('profile fields round-trip; skills are trimmed and de-duplicated; NULL reads as []', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);

  const before = await getStaffById(s.tenantId, s.staffA);
  assert.deepEqual(before?.skills, [], 'a never-set skills column reads as an empty array, not null');
  assert.equal(before?.title, null);
  assert.equal(before?.takes_bookings, true, 'existing rows default to agendable');

  const row = await updateStaff(s.tenantId, s.staffA, {
    title: '  Colour specialist  ',
    employmentType: 'part_time',
    weeklyHours: 24,
    startDate: '2021-03-15',
    skills: [' Balayage ', 'Balayage', '', 'Fades'],
    takesBookings: false,
  });
  assert.equal(row?.title, 'Colour specialist', 'trimmed');
  assert.equal(row?.employment_type, 'part_time');
  assert.equal(row?.weekly_hours, 24);
  assert.deepEqual(row?.skills, ['Balayage', 'Fades'], 'blanks dropped, duplicates collapsed');
  assert.equal(row?.takes_bookings, false, 'works here, but has no chair');
  // start_date is a DATE — compare the calendar day, not an instant.
  assert.equal(row?.start_date?.toISOString().slice(0, 10), '2021-03-15');

  // Clearing goes back to NULL rather than storing "".
  const cleared = await updateStaff(s.tenantId, s.staffA, { title: '   ' });
  assert.equal(cleared?.title, null);
});

test('PII is written by updateStaff but NEVER returned by the default reads', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);

  await updateStaff(s.tenantId, s.staffA, {
    phone: '+57 300 111 2233',
    email: 'barber@example.com',
    emergencyContactName: 'A Relative',
    emergencyContactPhone: '+57 300 999 0000',
  });

  // It really is stored.
  const raw = await query<{ phone: string | null }>(`SELECT phone FROM staff WHERE id = $1`, [s.staffA]);
  assert.equal(raw.rows[0].phone, '+57 300 111 2233');

  // ...and the operational reads cannot see it. `in` on the returned object is the
  // point: the column must be absent, not merely null.
  const listed = await listStaff(s.tenantId, { siteId: s.siteId });
  const one = await getStaffById(s.tenantId, s.staffA);
  const updated = await updateStaff(s.tenantId, s.staffA, { title: 'Barber' });
  for (const [label, row] of [
    ['listStaff', listed.find((r) => r.id === s.staffA)!],
    ['getStaffById', one!],
    ['updateStaff RETURNING', updated!],
  ] as const) {
    for (const col of ['phone', 'email', 'emergency_contact_name', 'emergency_contact_phone']) {
      assert.ok(!(col in row), `${label} must not return ${col}`);
    }
  }

  // The admin reads are the only door, and they still scope by tenant.
  const admin = await getStaffByIdAdmin(s.tenantId, s.staffA);
  assert.equal(admin?.phone, '+57 300 111 2233');
  assert.equal(admin?.email, 'barber@example.com');
  assert.equal(admin?.emergency_contact_name, 'A Relative');
  const adminList = await listStaffAdmin(s.tenantId, { siteId: s.siteId });
  assert.equal(adminList.find((r) => r.id === s.staffA)?.emergency_contact_phone, '+57 300 999 0000');

  const otherTenant = await seedScenario({ enableScheduling: true });
  tenants.push(otherTenant.tenantId);
  assert.equal(await getStaffByIdAdmin(otherTenant.tenantId, s.staffA), null, 'cross-tenant read is blocked');
});

test('the CHECK constraints reject bad contract data', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);

  await assert.rejects(
    () => updateStaff(s.tenantId, s.staffA, { employmentType: 'freelance' as never }),
    /staff_employment_type_valid/,
  );
  await assert.rejects(() => updateStaff(s.tenantId, s.staffA, { weeklyHours: 0 }), /staff_weekly_hours_valid/);
  await assert.rejects(() => updateStaff(s.tenantId, s.staffA, { weeklyHours: 200 }), /staff_weekly_hours_valid/);
  // NULL is always allowed — the fields are optional.
  const ok = await updateStaff(s.tenantId, s.staffA, { employmentType: null, weeklyHours: null });
  assert.equal(ok?.employment_type, null);
});

test('certifications belong to a staff member of the SAME tenant, and expiry ordering holds', async () => {
  const s = await seedScenario({ enableScheduling: true });
  const other = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId, other.tenantId);

  const soon = await createStaffCertification({
    tenantId: s.tenantId,
    staffId: s.staffA,
    name: 'Wella Master Colorist',
    issuer: 'Wella',
    issuedOn: '2023-01-10',
    expiresOn: '2026-01-10',
  });
  await createStaffCertification({ tenantId: s.tenantId, staffId: s.staffA, name: 'Barbering Licence' });

  const byStaff = await listStaffCertifications(s.tenantId, [s.staffA]);
  const rows = byStaff.get(s.staffA) ?? [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Wella Master Colorist', 'dated first, never-expires last');
  assert.equal(rows[1].expires_on, null);

  // Another tenant's staff id writes nothing (the SQL EXISTS guard) — not an orphan.
  await assert.rejects(
    () => createStaffCertification({ tenantId: s.tenantId, staffId: other.staffA, name: 'Forged' }),
    /staff not found for tenant/,
  );
  // ...and cannot be read across tenants either.
  assert.equal((await listStaffCertifications(other.tenantId, [s.staffA])).size, 0);

  await assert.rejects(
    () =>
      createStaffCertification({
        tenantId: s.tenantId,
        staffId: s.staffA,
        name: 'Backwards',
        issuedOn: '2025-01-01',
        expiresOn: '2024-01-01',
      }),
    /staff_certifications_dates_valid/,
  );

  assert.equal(await deleteStaffCertification(s.tenantId, soon.id), true);
  assert.equal(await deleteStaffCertification(other.tenantId, soon.id), false, 'no cross-tenant delete');
});

test('services.category is optional, constrained, and clearable', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);

  const plain = await createService({ tenantId: s.tenantId, clientId: s.clientId, name: 'Corte', durationMin: 30 });
  assert.equal(plain.category, null, 'no category is the valid default — the agenda falls back to the name');

  const colour = await createService({
    tenantId: s.tenantId,
    clientId: s.clientId,
    name: 'Balayage',
    durationMin: 120,
    category: 'color',
  });
  assert.equal(colour.category, 'color');

  const moved = await updateService(s.tenantId, s.clientId, plain.id, { category: 'cut' });
  assert.equal(moved?.category, 'cut');
  const cleared = await updateService(s.tenantId, s.clientId, plain.id, { category: null });
  assert.equal(cleared?.category, null, 'clearing returns the service to keyword inference');

  await assert.rejects(
    () => updateService(s.tenantId, s.clientId, plain.id, { category: 'sparkles' as never }),
    /services_category_valid/,
  );

  const all = await listServices(s.tenantId, s.clientId);
  assert.ok(all.every((x) => 'category' in x), 'category is projected on the normal list read');
});
