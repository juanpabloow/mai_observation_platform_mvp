import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { listCandidatesForContact } from '../../src/db/repositories/contactIdentities.js';
import { cleanupTenant, closeDb, seedContact, seedScenario } from './fixtures.js';

/**
 * C-4: the per-contact duplicate-candidate query behind the record's duplicate banner.
 * listCandidatesForContact must return unresolved candidates where the contact is on
 * EITHER side (keep or duplicate), stay client-scoped, and never surface a resolved row.
 * (listOpenCandidates' client-wide variant is already proven; this guards the new
 * either-side + per-contact filter.)
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});

test('listCandidatesForContact: either side, client-scoped, unresolved only', async () => {
  const s = await seedScenario({ enableCrm: true });
  tenants.push(s.tenantId);

  const keep = await seedContact(s.tenantId, s.clientId, { name: 'Ana Keep', channelUserId: 'wa:keep' });
  const dup = await seedContact(s.tenantId, s.clientId, { name: 'Ana Dup', channelUserId: 'wa:dup' });
  const unrelated = await seedContact(s.tenantId, s.clientId, { name: 'Bob', channelUserId: 'wa:bob' });

  await query(
    `INSERT INTO duplicate_contact_candidates (tenant_id, client_id, contact_id_keep, contact_id_duplicate, reason)
     VALUES ($1, $2, $3, $4, 'identity_collision')`,
    [s.tenantId, s.clientId, keep, dup],
  );

  // Visible from BOTH sides of the pair.
  assert.equal((await listCandidatesForContact(s.tenantId, s.clientId, keep)).length, 1, 'keep side');
  assert.equal((await listCandidatesForContact(s.tenantId, s.clientId, dup)).length, 1, 'duplicate side');
  const row = (await listCandidatesForContact(s.tenantId, s.clientId, keep))[0];
  assert.equal(row.contact_id_keep, keep);
  assert.equal(row.contact_id_duplicate, dup);
  assert.equal(row.keep_name, 'Ana Keep');
  assert.equal(row.dup_name, 'Ana Dup');

  // An unrelated contact sees none; a foreign client sees none.
  assert.equal((await listCandidatesForContact(s.tenantId, s.clientId, unrelated)).length, 0, 'unrelated contact');
  assert.equal((await listCandidatesForContact(s.tenantId, s.otherClientId, keep)).length, 0, 'foreign client');

  // Resolving the candidate removes it from the banner query.
  await query(`UPDATE duplicate_contact_candidates SET resolved_at = now() WHERE tenant_id=$1 AND client_id=$2`, [s.tenantId, s.clientId]);
  assert.equal((await listCandidatesForContact(s.tenantId, s.clientId, keep)).length, 0, 'resolved is hidden');
});
