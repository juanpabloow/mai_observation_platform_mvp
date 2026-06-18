import { closePool, query } from '../db/client.js';
import { listClientsForTenant } from '../db/repositories/clients.js';
import {
  createOrReplacePendingInvitation,
  generateInviteToken,
  hashInviteToken,
  normalizeEmail,
  type InvitationRole,
} from '../db/repositories/invitations.js';

/**
 * INTERIM invite trigger for RBAC-2 testing (the real path is createInvitationAction
 * + the /settings/team form). Mirrors that action's core using the same repo, and
 * sends the email via the same Resend REST call, but RETURNS the raw token so the
 * accept flow can be exercised end-to-end in verification. RBAC-3's UI supersedes it.
 *
 *   npm run rbac2:invite -- <email> <admin|member> [clientId|clientName] [tenantId]
 *
 * Defaults to the MAI tenant; uses an existing owner/admin as the inviter.
 */
const MAI = '11111111-1111-1111-1111-111111111111';
const TTL_DAYS = 7;
const ROLES = ['admin', 'member'] as const;

async function sendViaResend(
  to: string,
  subject: string,
  html: string,
): Promise<{ ok: boolean; detail: string }> {
  const key = process.env.RESEND_API_KEY;
  const fromEmail = process.env.INVITE_FROM_EMAIL;
  if (!key || !fromEmail) return { ok: false, detail: 'not configured' };
  const fromName = process.env.RESEND_FROM_NAME?.trim() || 'MontserratAI';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${fromName} <${fromEmail}>`, to, subject, html }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    return { ok: true, detail: (JSON.parse(text) as { id?: string }).id ?? 'sent' };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

async function main(): Promise<void> {
  const email = process.argv[2]?.trim();
  const role = process.argv[3]?.trim() as InvitationRole | undefined;
  const clientArg = process.argv[4]?.trim();
  const tenantId = process.argv[5]?.trim() || MAI;

  if (!email || !role || !(ROLES as readonly string[]).includes(role)) {
    console.error('Usage: npm run rbac2:invite -- <email> <admin|member> [clientId|clientName] [tenantId]');
    process.exitCode = 1;
    return;
  }

  const owner = (
    await query<{ user_id: string }>(
      `SELECT user_id FROM tenant_members WHERE tenant_id = $1 AND role IN ('owner','admin')
        ORDER BY created_at ASC LIMIT 1`,
      [tenantId],
    )
  ).rows[0];
  if (!owner) throw new Error(`No owner/admin found for tenant ${tenantId}.`);

  let memberClientId: string | null = null;
  if (role === 'member') {
    if (!clientArg) throw new Error("role 'member' requires a clientId or client name.");
    const clients = await listClientsForTenant(tenantId);
    const match = clients.find((c) => c.id === clientArg || c.name === clientArg);
    if (!match) {
      throw new Error(
        `No client "${clientArg}" in tenant. Available: ${clients.map((c) => c.name).join(', ')}`,
      );
    }
    memberClientId = match.id;
  }

  const rawToken = generateInviteToken();
  const inv = await createOrReplacePendingInvitation({
    tenantId,
    email: normalizeEmail(email),
    role,
    memberClientId,
    tokenHash: hashInviteToken(rawToken),
    invitedBy: owner.user_id,
    expiresAt: new Date(Date.now() + TTL_DAYS * 24 * 60 * 60 * 1000),
  });

  const base = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  const acceptUrl = `${base}/invite/accept?token=${rawToken}`;
  const send = await sendViaResend(
    inv.email,
    `You've been invited (test)`,
    `<p>Accept your invitation: <a href="${acceptUrl}">${acceptUrl}</a></p>`,
  );

  console.log(
    JSON.stringify(
      {
        invitationId: inv.id,
        tenantId,
        email: inv.email,
        role,
        memberClientId,
        status: inv.status,
        expires_at: inv.expires_at,
        emailSend: send,
        acceptUrl,
        rawToken,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err: unknown) => {
    console.error(String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
