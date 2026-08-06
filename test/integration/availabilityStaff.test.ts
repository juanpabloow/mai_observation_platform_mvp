import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { zonedPartsToUtc } from '../../src/scheduling/timezone.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import { listStaff, listStaffForService } from '../../src/db/repositories/scheduling/staff.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * The engine behaviour the availability route builds on for the E-1 addendum:
 *   - a staff filter returns a SUBSET of the unfiltered slots, each including that staff;
 *   - an UNQUALIFIED staff+service pair produces an empty engine result (the failure mode
 *     the route now converts to a distinct staff_service_mismatch instead of "no slots");
 *   - listStaffForService is exactly the membership the route checks + the names it labels.
 * In the fixtures both barbers do Haircut; only Ana (staffA) does Color.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 1, 0, 0, TZ);
const FROM = zonedPartsToUtc(2026, 8, 5, 0, 0, TZ);
const TO = zonedPartsToUtc(2026, 8, 6, 0, 0, TZ);

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  return s;
}
const avail = (s: { tenantId: string; siteId: string }, serviceId: string, staffId: string | null) =>
  loadAvailability({ tenantId: s.tenantId, siteId: s.siteId, serviceId, staffId, from: FROM, to: TO, now: NOW });

test('staff filter returns a SUBSET of unfiltered slots, each including that staff', async () => {
  const s = await scenario();
  const all = await avail(s, s.serviceHaircut, null);
  const ana = await avail(s, s.serviceHaircut, s.staffA);
  assert.ok(all && ana);
  if (!all || !ana) throw new Error('unreachable');
  assert.ok(ana.slots.length > 0 && ana.slots.length <= all.slots.length, 'filtered ⊆ unfiltered');
  const allStarts = new Set(all.slots.map((x) => x.start_at.toISOString()));
  for (const slot of ana.slots) {
    assert.ok(slot.available_staff_ids.includes(s.staffA), 'every filtered slot includes Ana');
    assert.ok(allStarts.has(slot.start_at.toISOString()), 'filtered start is present in the unfiltered set');
  }
});

test('unqualified staff+service → empty engine result (the route turns this into a specific error)', async () => {
  const s = await scenario();
  // Ana does Color; Beto does not.
  const qualified = await listStaffForService(s.tenantId, s.siteId, s.serviceColor);
  const ids = qualified.map((q) => q.id);
  assert.ok(ids.includes(s.staffA) && !ids.includes(s.staffB), 'only Ana qualifies for Color');

  const betoColor = await avail(s, s.serviceColor, s.staffB);
  assert.equal(betoColor?.slots.length, 0, 'Beto+Color yields NO slots (indistinguishable from "no availability" without the route error)');
  const anaColor = await avail(s, s.serviceColor, s.staffA);
  assert.ok((anaColor?.slots.length ?? 0) > 0, 'Ana+Color has slots');
});

test('staff names used for the slot labels are correct', async () => {
  const s = await scenario();
  const rows = await listStaff(s.tenantId, { siteId: s.siteId, includeInactive: true });
  const nameById = new Map(rows.map((r) => [r.id, r.name] as const));
  assert.equal(nameById.get(s.staffA), 'Ana');
  assert.equal(nameById.get(s.staffB), 'Beto');
});
