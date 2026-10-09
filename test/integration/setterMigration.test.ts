import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import type { PoolClient } from 'pg';
import { pool } from '../../src/db/client.js';
import { up, down } from '../../migrations/1795000000000_setter-role.js';
import { cleanupTenant, closeDb, seedScenario } from './fixtures.js';

after(closeDb);

/**
 * The PRE-1795 CHECK (from migration 1790): it allows client_role IN ('owner','editor')
 * and does NOT allow 'setter'. Reproducing it is the whole point — the original bug was
 * that 1795 ran `UPDATE editor → setter` while this constraint was still in place, so an
 * existing editor row raised 23514 and the migration rolled back in production.
 */
const EDITOR_CHECK = `(
  (
    role = 'member' AND (
      (client_role IN ('owner','editor') AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL)
      OR (client_role = 'staff' AND scheduling_site_id IS NOT NULL AND scheduling_staff_id IS NOT NULL)
    )
  )
  OR (
    role <> 'member' AND client_role IS NULL
    AND scheduling_site_id IS NULL AND scheduling_staff_id IS NULL
  )
)`;

/** Execute the migration MODULE's own pgm.sql() statements on one client (so the test
 *  exercises the real migration, not a copy of its SQL). */
async function runMigration(
  client: PoolClient,
  fn: (pgm: { sql: (s: string) => void }) => Promise<void>,
): Promise<void> {
  const sqls: string[] = [];
  await fn({ sql: (s: string) => sqls.push(s) }); // up/down call pgm.sql synchronously
  for (const s of sqls) await client.query(s);
}

test('1795 setter-role: editor↔setter survives up→down→up with real rows (23514 regression)', async () => {
  const scenario = await seedScenario(); // tenant + a non-default client (committed)
  const client = await pool.connect();
  try {
    // Everything runs in ONE transaction and is rolled back at the end, so the test DB's
    // live schema (already on the 'setter' CHECK) is left exactly as it was.
    await client.query('BEGIN');

    // Rewind this txn's view to the pre-1795 state: the OLD 'editor' CHECK.
    for (const tbl of ['tenant_members', 'invitations']) {
      await client.query(`ALTER TABLE ${tbl} DROP CONSTRAINT IF EXISTS ${tbl}_client_role_check`);
      await client.query(`ALTER TABLE ${tbl} ADD CONSTRAINT ${tbl}_client_role_check CHECK ${EDITOR_CHECK}`);
    }

    // The exact rows that broke prod: one EDITOR member + one pending EDITOR invitation.
    const inviterId = randomUUID();
    const memberId = randomUUID();
    await client.query(
      `INSERT INTO "user" (id, name, email, "emailVerified")
       VALUES ($1,'Inviter',$2,true), ($3,'Ed',$4,true)`,
      [inviterId, `${inviterId.slice(0, 8)}@t.local`, memberId, `${memberId.slice(0, 8)}@t.local`],
    );
    await client.query(
      `INSERT INTO tenant_members (tenant_id, user_id, role, member_client_id, client_role)
       VALUES ($1, $2, 'member', $3, 'editor')`,
      [scenario.tenantId, memberId, scenario.clientId],
    );
    const inviteEmail = `pending-${randomUUID().slice(0, 8)}@t.local`;
    await client.query(
      `INSERT INTO invitations (tenant_id, email, role, member_client_id, client_role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'member', $3, 'editor', $4, $5, now() + interval '7 days')`,
      [scenario.tenantId, inviteEmail, scenario.clientId, createHash('sha256').update(randomUUID()).digest('hex'), inviterId],
    );

    const memberRole = async () =>
      (await client.query<{ client_role: string }>(`SELECT client_role FROM tenant_members WHERE user_id = $1`, [memberId])).rows[0]?.client_role;
    const inviteRole = async () =>
      (await client.query<{ client_role: string }>(`SELECT client_role FROM invitations WHERE tenant_id = $1 AND email = $2`, [scenario.tenantId, inviteEmail])).rows[0]?.client_role;

    // UP — must NOT raise 23514 (the fix), and both rows become 'setter'.
    await runMigration(client, up);
    assert.equal(await memberRole(), 'setter', 'member → setter after up');
    assert.equal(await inviteRole(), 'setter', 'invitation → setter after up');

    // DOWN — both revert to 'editor'.
    await runMigration(client, down);
    assert.equal(await memberRole(), 'editor', 'member → editor after down');
    assert.equal(await inviteRole(), 'editor', 'invitation → editor after down');

    // UP again — re-runnable, back to 'setter'.
    await runMigration(client, up);
    assert.equal(await memberRole(), 'setter', 'member → setter after second up');
    assert.equal(await inviteRole(), 'setter', 'invitation → setter after second up');

    await client.query('ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await cleanupTenant(scenario.tenantId);
  }
});
