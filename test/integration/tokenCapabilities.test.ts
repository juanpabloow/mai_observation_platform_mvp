import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';
import { query } from '../../src/db/client.js';
import {
  issueToken,
  findActiveByHash,
  hashHandoffToken,
  revokeToken,
  updateTokenCapabilities,
  LEGACY_CAPABILITIES,
} from '../../src/db/repositories/handoffTokens.js';
import { runBackfill } from '../../src/scripts/backfillTokenCapabilities.js';
import { cleanupTenant, closeDb, seedScenario, seedWorkflow } from './fixtures.js';

/**
 * C-5 token capabilities: issue stores the chosen set; the auth lookup returns it; the
 * backfill grants EXACTLY the legacy triple to capability-less tokens (idempotent, no
 * crm.*); narrowing takes effect immediately and revoked tokens aren't editable.
 */

const tenants: string[] = [];
after(async () => {
  for (const t of tenants) await cleanupTenant(t);
  await closeDb();
});
async function scenario() {
  const s = await seedScenario();
  tenants.push(s.tenantId);
  const { connectionId } = await seedWorkflow(s.tenantId, s.clientId, `wf-${s.tenantId.slice(0, 6)}`);
  return { ...s, connectionId };
}
const sorted = (a: readonly string[]) => [...a].sort();

test('issueToken stores the chosen capabilities; findActiveByHash returns them', async () => {
  const s = await scenario();
  const { row, rawToken } = await issueToken(s.tenantId, s.connectionId, ['handoff', 'crm.read']);
  assert.deepEqual(sorted(row.capabilities), ['crm.read', 'handoff']);
  const found = await findActiveByHash(hashHandoffToken(rawToken));
  assert.ok(found);
  assert.deepEqual(sorted(found!.capabilities), ['crm.read', 'handoff'], 'the auth lookup carries capabilities');
});

test('issueToken drops unknown/duplicate capability strings', async () => {
  const s = await scenario();
  const { row } = await issueToken(s.tenantId, s.connectionId, ['handoff', 'handoff', 'bogus.cap' as never]);
  assert.deepEqual(row.capabilities, ['handoff'], 'deduped + vocabulary-filtered');
});

test('backfill grants the legacy triple to capability-less tokens ONLY, and is idempotent', async () => {
  const s = await scenario();
  // A token with NO capabilities (as a pre-C-5 row would be before backfill).
  const empty = await query<{ id: string }>(
    `INSERT INTO handoff_tokens (tenant_id, n8n_connection_id, token_hash, token_prefix, capabilities)
       VALUES ($1, $2, $3, 'hk_empty', '{}'::text[]) RETURNING id`,
    [s.tenantId, s.connectionId, `hash-${s.tenantId}`],
  );
  // A token an admin already narrowed — must NOT be clobbered.
  const narrowed = await issueToken(s.tenantId, s.connectionId, ['handoff']);

  const r1 = await runBackfill();
  const mine = r1.perTenant.find((l) => l.tenantId === s.tenantId)!;
  assert.ok(mine.updated >= 1, 'the empty token was backfilled');

  const emptyNow = (await query<{ capabilities: string[] }>(`SELECT capabilities FROM handoff_tokens WHERE id=$1`, [empty.rows[0].id])).rows[0];
  assert.deepEqual(sorted(emptyNow.capabilities), sorted(LEGACY_CAPABILITIES), 'empty → legacy triple');
  assert.ok(!emptyNow.capabilities.includes('crm.read') && !emptyNow.capabilities.includes('crm.write'), 'NO crm.* granted');

  const narrowedNow = (await query<{ capabilities: string[] }>(`SELECT capabilities FROM handoff_tokens WHERE id=$1`, [narrowed.row.id])).rows[0];
  assert.deepEqual(narrowedNow.capabilities, ['handoff'], 'a configured token is left untouched');

  // Idempotent: a second run changes nothing for this tenant.
  const r2 = await runBackfill();
  const mine2 = r2.perTenant.find((l) => l.tenantId === s.tenantId)!;
  assert.equal(mine2.updated, 0, 're-running sets nothing new');
});

test('updateTokenCapabilities narrows immediately; revoked tokens are not editable', async () => {
  const s = await scenario();
  const { row, rawToken } = await issueToken(s.tenantId, s.connectionId, ['handoff', 'scheduling.read', 'scheduling.write']);
  const narrowed = await updateTokenCapabilities(s.tenantId, row.id, ['handoff']);
  assert.ok(narrowed && narrowed.capabilities.length === 1);
  const found = await findActiveByHash(hashHandoffToken(rawToken));
  assert.deepEqual(found!.capabilities, ['handoff'], 'the next auth lookup sees the narrowed set');

  await revokeToken(s.tenantId, row.id);
  const afterRevoke = await updateTokenCapabilities(s.tenantId, row.id, ['handoff', 'crm.read']);
  assert.equal(afterRevoke, null, 'a revoked token cannot be edited');
});
