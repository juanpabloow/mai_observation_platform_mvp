import { closePool } from '../db/client.js';
import {
  findUserIdByEmail,
  getMembershipForUser,
  setMembershipRole,
} from '../db/repositories/tenantMembers.js';
import { listClientsForTenant } from '../db/repositories/clients.js';
import { logger } from '../logger.js';

/**
 * RBAC simulation / admin: set a user's role within their tenant. RBAC-3 will add
 * the real team-management UI; for now this is the internal stand-in used to
 * SIMULATE a member (and an admin) so the access enforcement can be tested.
 *
 *   npm run rbac:set-role -- <email> owner
 *   npm run rbac:set-role -- <email> admin
 *   npm run rbac:set-role -- <email> member "<clientId | client name>"
 *
 * 'member' requires a client (its id OR display name, resolved within the user's
 * own tenant). owner/admin clear the member client. The DB enforces the rest
 * (same-tenant via the composite FK, role↔client via the CHECK), so a bad client
 * id/name or a cross-tenant client is rejected at write time.
 */
const ROLES = ['owner', 'admin', 'member'] as const;
type RoleArg = (typeof ROLES)[number];

function isRole(v: string | undefined): v is RoleArg {
  return v !== undefined && (ROLES as readonly string[]).includes(v);
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  const role = process.argv[3]?.trim();
  const clientArg = process.argv[4]?.trim();

  if (!email || !isRole(role)) {
    console.error(
      'Usage: npm run rbac:set-role -- <email> <owner|admin|member> [clientId|clientName]',
    );
    process.exitCode = 1;
    return;
  }

  const userId = await findUserIdByEmail(email);
  if (!userId) throw new Error(`No user found with email "${email}". Sign up first, then run this.`);

  const membership = await getMembershipForUser(userId);
  if (!membership) throw new Error(`User "${email}" has no tenant membership.`);
  const tenantId = membership.tenant_id;

  let memberClientId: string | null = null;
  if (role === 'member') {
    if (!clientArg) throw new Error("role 'member' requires a clientId or client name.");
    const clients = await listClientsForTenant(tenantId);
    const match = clients.find((c) => c.id === clientArg || c.name === clientArg);
    if (!match) {
      const avail = clients
        .map((c) => `  ${c.name}${c.is_default ? ' (default)' : ''} = ${c.id}`)
        .join('\n');
      throw new Error(`No client "${clientArg}" in tenant ${tenantId}. Available:\n${avail}`);
    }
    memberClientId = match.id;
  }

  const updated = await setMembershipRole({ tenantId, userId, role, memberClientId });
  if (updated === 0) throw new Error('No membership row was updated (unexpected).');

  const after = await getMembershipForUser(userId);
  const summary = { email, userId, tenantId, role, memberClientId, after };
  logger.info(summary, 'rbac:set-role applied');
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, 'rbac:set-role failed');
    console.error(String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
