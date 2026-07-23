import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  isClientModuleEnabled,
  setClientModuleEnabled,
} from '../../src/db/repositories/clientModules.js';
import { resolveOrCreateContact, updateContact, getContactById } from '../../src/db/repositories/contacts.js';
import { getSiteById } from '../../src/db/repositories/scheduling/sites.js';
import { cleanupTenant, closeDb, seedScenario, seedSiteForClient } from './fixtures.js';

/**
 * Phase 3A domain/repository invariants behind the web gate (the session helper
 * itself needs a request context, so — per the plan — its data-layer invariants
 * are proven here and the session path is covered by the documented manual test):
 *
 * - module gate primitives: enabled row → true; absent / enabled=false → false
 *   (what resolveClientModuleContext consults after canAccessClient).
 * - contact writes are client-scoped even with a valid tenant: a forged/foreign
 *   clientId updates NOTHING.
 * - the internal-availability site↔client check: a site of another client can
 *   never satisfy site.client_id === client_id.
 *
 * Cross-client booking-action invariants (create/transition/reschedule with a
 * mismatched scopeClientId are not-found, zero writes) are already covered in
 * booking.test.ts ("client scope: acting under another client…").
 */

const tenants: string[] = [];
async function scenario() {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  return s;
}

after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('module gate: enabled row allows, absent row and enabled=false deny', async () => {
  const s = await scenario();
  // Absent → deny.
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'crm'), false);
  // Enabled → allow.
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: true });
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'crm'), true);
  // Row kept but disabled → deny again.
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'crm', enabled: false });
  assert.equal(await isClientModuleEnabled(s.tenantId, s.clientId, 'crm'), false);
});

test('module gate: foreign tenant/client combinations deny', async () => {
  const a = await scenario();
  const b = await scenario();
  await setClientModuleEnabled({ tenantId: a.tenantId, clientId: a.clientId, moduleKey: 'scheduling', enabled: true });
  // Another tenant asking about A's client → false (tenant-scoped read).
  assert.equal(await isClientModuleEnabled(b.tenantId, a.clientId, 'scheduling'), false);
  // Same tenant, other client without a row → false.
  assert.equal(await isClientModuleEnabled(a.tenantId, a.otherClientId, 'scheduling'), false);
});

test('contact update with a forged clientId writes NOTHING (also for valid tenants)', async () => {
  const s = await scenario();
  const contact = await resolveOrCreateContact({
    tenantId: s.tenantId,
    clientId: s.clientId,
    channel: 'whatsapp',
    channelUserId: '573000009999',
    name: 'Original Name',
  });

  // Forged/foreign client id (another client of the SAME tenant) → null, no write.
  const forged = await updateContact(s.tenantId, contact.id, { name: 'Hacked' }, s.otherClientId);
  assert.equal(forged, null, 'cross-client update returns null');
  const reload = await getContactById(s.tenantId, contact.id);
  assert.equal(reload?.name, 'Original Name', 'name unchanged after forged attempt');

  // The right client scope updates normally.
  const ok = await updateContact(s.tenantId, contact.id, { name: 'Renamed' }, s.clientId);
  assert.equal(ok?.name, 'Renamed');
});

test("internal availability's site↔client check: another client's site never matches", async () => {
  const s = await scenario();
  const other = await seedSiteForClient(s.tenantId, s.otherClientId);

  // The exact comparison the internal endpoint enforces after the module gate:
  // getSiteById (tenant-scoped) then site.client_id === client_id.
  const siteOfOther = await getSiteById(s.tenantId, other.siteId);
  assert.ok(siteOfOther, 'site exists in the tenant');
  assert.notEqual(siteOfOther.client_id, s.clientId, "another client's site can't satisfy the check");
  const siteOfMine = await getSiteById(s.tenantId, s.siteId);
  assert.equal(siteOfMine?.client_id, s.clientId, "own site does satisfy it");

  // And a site id from ANOTHER TENANT doesn't even resolve.
  const b = await scenario();
  assert.equal(await getSiteById(b.tenantId, s.siteId), null);
});

test('appointments/site data stays reachable after a module is disabled (no deletion)', async () => {
  const s = await scenario();
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: true });
  await setClientModuleEnabled({ tenantId: s.tenantId, clientId: s.clientId, moduleKey: 'scheduling', enabled: false });
  // The gate now denies, but the underlying scheduling data is intact.
  const sites = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM sites WHERE tenant_id = $1 AND client_id = $2`, [s.tenantId, s.clientId]);
  assert.ok(sites.rows[0].n >= 1, 'sites survive a module toggle');
});
