import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, mock, test } from 'node:test';
import { query } from '../../src/db/client.js';
import { cleanupTenant, closeDb, seedMember, seedScenario } from './fixtures.js';
import {
  createOrReplacePendingInvitation,
  generateInviteToken,
  hashInviteToken,
  normalizeEmail,
} from '../../src/db/repositories/invitations.js';

/**
 * FIX-1 — accepting a valid invitation marks the account email-verified (the single-use token was
 * delivered to that inbox and the signed-in email matches, so acceptance PROVES ownership). This
 * lifts an invited email/password user out of the unverified-sign-in limbo. Hitting the real
 * acceptInvitationAction with a stubbed session + Next boundaries (mirrors pipelineActions.test.ts).
 */
let CURRENT: { id: string; email: string } | null = null;
mock.module('../../web/lib/session.ts', {
  namedExports: { getServerSession: async () => (CURRENT ? { user: { id: CURRENT.id, email: CURRENT.email }, session: {} } : null) },
});
const reqFromWeb = createRequire(pathToFileURL(resolvePath(process.cwd(), 'web/lib/access.ts')));
const urlOf = (spec: string) => pathToFileURL(reqFromWeb.resolve(spec)).href;
mock.module(urlOf('next/navigation'), { namedExports: { redirect: () => { throw new Error('redirect'); }, notFound: () => { throw new Error('notFound'); } } });
mock.module(urlOf('next/headers'), { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined, getAll: () => [] }) } });
mock.module(urlOf('next/cache'), { namedExports: { revalidatePath: () => {}, revalidateTag: () => {} } });

const { acceptInvitationAction } = await import('../../web/lib/inviteActions.js');
after(closeDb);

type S = Awaited<ReturnType<typeof seedScenario>>;
const verifiedOf = (id: string) => query<{ v: boolean }>(`SELECT "emailVerified" AS v FROM "user" WHERE id = $1`, [id]).then((r) => r.rows[0]?.v);
const memberCount = (s: S, userId: string) => query<{ n: string }>(`SELECT count(*)::text n FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`, [s.tenantId, userId]).then((r) => r.rows[0]!.n);

/** A bare Better Auth user row (no membership → tenant-less, like a fresh invited signup). */
async function seedAuthUser(email: string, emailVerified: boolean): Promise<string> {
  const id = randomUUID();
  await query(`INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, $4)`, [id, email.split('@')[0], email, emailVerified]);
  return id;
}

/** A pending invitation for `email` (member/setter of clientId), returning the RAW token. */
async function seedInvite(s: S, email: string): Promise<string> {
  const inviter = await seedMember(s.tenantId, { role: 'owner' });
  const raw = generateInviteToken();
  await createOrReplacePendingInvitation({
    tenantId: s.tenantId,
    email: normalizeEmail(email),
    role: 'member',
    memberClientId: s.clientId,
    clientRole: 'setter',
    tokenHash: hashInviteToken(raw),
    invitedBy: inviter,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  return raw;
}

test('invited + password: accepting a valid invitation marks the UNVERIFIED account verified and creates the membership', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const email = `invited-${randomUUID().slice(0, 8)}@test.local`;
    const userId = await seedAuthUser(email, false); // unverified, like a fresh password signup
    const token = await seedInvite(s, email);
    CURRENT = { id: userId, email };

    assert.equal(await verifiedOf(userId), false, 'starts unverified');
    const r = await acceptInvitationAction(token);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    assert.equal(await verifiedOf(userId), true, 'FIX-1: acceptance verified the email');
    assert.equal(await memberCount(s, userId), '1', 'membership created in the inviting tenant');
  } finally { CURRENT = null; await cleanupTenant(s.tenantId); }
});

test('invited + Google (already provider-verified): accept creates the membership and leaves verified true', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const email = `ginvited-${randomUUID().slice(0, 8)}@test.local`;
    const userId = await seedAuthUser(email, true); // Google users are provider-verified
    const token = await seedInvite(s, email);
    CURRENT = { id: userId, email };

    const r = await acceptInvitationAction(token);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    assert.equal(await verifiedOf(userId), true);
    assert.equal(await memberCount(s, userId), '1');
  } finally { CURRENT = null; await cleanupTenant(s.tenantId); }
});

test('the verify-on-accept is token + email gated: a mismatched signed-in email is refused and stays unverified', async () => {
  const s = await seedScenario({ enableCrm: true });
  try {
    const invitedEmail = `real-${randomUUID().slice(0, 8)}@test.local`;
    const token = await seedInvite(s, invitedEmail);
    // A DIFFERENT, unverified account tries to consume the token.
    const otherEmail = `other-${randomUUID().slice(0, 8)}@test.local`;
    const otherId = await seedAuthUser(otherEmail, false);
    CURRENT = { id: otherId, email: otherEmail };

    const r = await acceptInvitationAction(token);
    assert.equal(r.ok, false, 'a non-invited email cannot accept');
    assert.equal(await verifiedOf(otherId), false, 'and is NOT verified — acceptance never happened');
    assert.equal(await memberCount(s, otherId), '0', 'no membership created');
  } finally { CURRENT = null; await cleanupTenant(s.tenantId); }
});
