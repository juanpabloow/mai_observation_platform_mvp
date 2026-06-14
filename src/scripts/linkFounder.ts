import { closePool, pool, query } from '../db/client.js';
import {
  findUserIdByEmail,
  linkUserToTenantAsOwner,
  listMembershipsForUser,
} from '../db/repositories/tenantMembers.js';
import { logger } from '../logger.js';

/**
 * Attach the founder's account to the EXISTING MAI tenant (which already owns
 * all the historical data) as owner, instead of leaving them on the fresh,
 * empty tenant the signup hook auto-creates.
 *
 *   npm run link:founder -- <email>
 *
 * Steps (idempotent + safe):
 *   1. Link the user to MAI as owner (ON CONFLICT no-op).
 *   2. Clean up the user's auto-created workspace tenant(s): delete ONLY tenants
 *      that are empty (no n8n_connections, no executions) and where this user is
 *      the sole member — never one that holds data or has other members.
 * Result: the founder ends up an owner of MAI only, so getCurrentTenantId()
 * returns MAI and the historical executions/conversations remain visible.
 */
const MAI_TENANT_ID = '11111111-1111-1111-1111-111111111111';

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  if (!email) {
    console.error('Usage: npm run link:founder -- <email>');
    process.exitCode = 1;
    return;
  }

  const tenant = await query<{ id: string; name: string }>(
    `SELECT id, name FROM tenants WHERE id = $1`,
    [MAI_TENANT_ID],
  );
  if (tenant.rows.length === 0) {
    throw new Error(`MAI tenant ${MAI_TENANT_ID} not found — nothing to link to.`);
  }

  const userId = await findUserIdByEmail(email);
  if (!userId) {
    throw new Error(`No user found with email "${email}". Sign up first, then run this.`);
  }

  // 1. Link to MAI as owner.
  await linkUserToTenantAsOwner({ userId, tenantId: MAI_TENANT_ID });

  // 2. Clean up auto-created workspace tenants for this user.
  const others = (await listMembershipsForUser(userId)).filter((m) => m.tenant_id !== MAI_TENANT_ID);
  let deletedTenants = 0;
  let detachedOnly = 0;
  for (const m of others) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const members = await client.query<{ c: string }>(
        `SELECT count(*)::text c FROM tenant_members WHERE tenant_id = $1`,
        [m.tenant_id],
      );
      const conns = await client.query<{ c: string }>(
        `SELECT count(*)::text c FROM n8n_connections WHERE tenant_id = $1`,
        [m.tenant_id],
      );
      const execs = await client.query<{ c: string }>(
        `SELECT count(*)::text c FROM executions WHERE tenant_id = $1`,
        [m.tenant_id],
      );
      const soleMember = members.rows[0].c === '1';
      const empty = conns.rows[0].c === '0' && execs.rows[0].c === '0';
      if (soleMember && empty) {
        // Safe to remove the throwaway tenant entirely (cascades its membership).
        await client.query(`DELETE FROM tenants WHERE id = $1`, [m.tenant_id]);
        deletedTenants += 1;
      } else {
        // Has data or other members — keep the tenant, just detach this user.
        await client.query(`DELETE FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`, [
          m.tenant_id,
          userId,
        ]);
        detachedOnly += 1;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  const finalMemberships = await listMembershipsForUser(userId);
  const summary = {
    email,
    userId,
    linkedTo: MAI_TENANT_ID,
    deletedAutoTenants: deletedTenants,
    detachedFromTenants: detachedOnly,
    memberships: finalMemberships.map((m) => ({ tenant_id: m.tenant_id, role: m.role })),
  };
  logger.info(summary, 'founder linked to MAI tenant');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'link:founder failed');
    console.error(String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
