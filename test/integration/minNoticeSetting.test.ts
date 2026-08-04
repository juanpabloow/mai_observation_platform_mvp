import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { zonedPartsToUtc, utcToZonedParts } from '../../src/scheduling/timezone.js';
import { loadAvailability } from '../../src/db/repositories/scheduling/availabilityData.js';
import { getSiteById, updateSite } from '../../src/db/repositories/scheduling/sites.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

/**
 * Minimum notice lives in sites.scheduling_config.min_notice_min and the availability engine
 * subtracts it from "now". This proves editing it (the operator-facing fix) actually shifts
 * availability — the "why does availability start N hours from now" the setting explains.
 */

const TZ = 'America/Bogota';
const NOW = zonedPartsToUtc(2026, 8, 5, 9, 0, TZ); // Wed 09:00 local, site opens 09:00
const FROM = zonedPartsToUtc(2026, 8, 5, 0, 0, TZ);
const TO = zonedPartsToUtc(2026, 8, 6, 0, 0, TZ);

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

const localHhMm = (d: Date): string => {
  const p = utcToZonedParts(d, TZ);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

test('editing min_notice_min shifts when availability starts (0 → 120 min)', async () => {
  const s = await seedScenario({ enableScheduling: true });
  tenants.push(s.tenantId);
  const avail = () => loadAvailability({ tenantId: s.tenantId, siteId: s.siteId, serviceId: s.serviceHaircut, staffId: null, from: FROM, to: TO, now: NOW });

  // Baseline: fixtures seed min_notice_min = 0, so the 09:00 start is offered.
  const before = await avail();
  assert.ok(before && before.slots.length > 0);
  if (!before) throw new Error('unreachable');
  assert.equal(localHhMm(before.slots[0].start_at), '09:00', 'with 0 notice the day starts at 09:00');

  // Edit the setting exactly as the UI does (merge over existing config).
  const site = await getSiteById(s.tenantId, s.siteId);
  await updateSite(s.tenantId, s.siteId, { schedulingConfig: { ...site!.scheduling_config, min_notice_min: 120 } });
  const persisted = await getSiteById(s.tenantId, s.siteId);
  assert.equal(persisted!.scheduling_config.min_notice_min, 120, 'the new value is stored on the site');

  // Now the first two hours from 09:00 are gone — the earliest slot is 11:00.
  const after = await avail();
  assert.ok(after && after.slots.length > 0, 'later slots still exist');
  if (!after) throw new Error('unreachable');
  assert.ok(after.slots.every((sl) => sl.start_at.getTime() >= zonedPartsToUtc(2026, 8, 5, 11, 0, TZ).getTime()), 'no slot before 11:00');
  assert.equal(localHhMm(after.slots[0].start_at), '11:00', 'earliest slot is now 11:00 (09:00 + 120 min)');
  // And the pre-edit list DID contain a now-excluded early slot — proving the shift is real.
  assert.ok(before.slots.some((sl) => sl.start_at.getTime() < zonedPartsToUtc(2026, 8, 5, 11, 0, TZ).getTime()), 'baseline had early slots that are now excluded');
});
