"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "./session";
import { requireFullAccessForAction } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import { getMembershipForUser } from "@worker/db/repositories/tenantMembers.js";
import {
  acceptInvitation,
  createOrReplacePendingInvitation,
  generateInviteToken,
  getInvitationByTokenHash,
  hashInviteToken,
  listInvitationsForTenant,
  normalizeEmail,
  revokeInvitation,
  type InvitationListRow,
  type InvitationRole,
} from "@worker/db/repositories/invitations.js";
import { sendEmail } from "./email";

const INVITE_TTL_DAYS = 7;
// Pragmatic email shape check (full RFC validation is overkill; the real proof of
// control is the accept flow requiring the matching signed-in email + the token).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function appBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
}

function roleLabel(role: InvitationRole, clientName: string | null): string {
  return role === "member" ? `a member of ${clientName ?? "a client"}` : "an admin";
}

function inviteEmailHtml(params: {
  inviterEmail: string;
  tenantName: string;
  role: InvitationRole;
  clientName: string | null;
  acceptUrl: string;
}): string {
  const what = roleLabel(params.role, params.clientName);
  // Inline styles only (email clients strip <style>); plain, legible, no tracking.
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1c1917">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#fff;border:1px solid #e7e5e4;border-radius:14px;padding:32px">
      <tr><td>
        <p style="margin:0 0 16px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#78716c">Workspace invitation</p>
        <h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;font-weight:600">You've been invited to ${escapeHtml(params.tenantName)}</h1>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#44403c">
          <strong>${escapeHtml(params.inviterEmail)}</strong> invited you to join
          <strong>${escapeHtml(params.tenantName)}</strong> as ${escapeHtml(what)}.
        </p>
        <a href="${params.acceptUrl}" style="display:inline-block;background:#059669;color:#fff;text-decoration:none;font-size:15px;font-weight:600;padding:11px 22px;border-radius:9px">Accept invitation</a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#78716c">
          This invitation expires in ${INVITE_TTL_DAYS} days. If you weren't expecting it, you can safely ignore this email.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * Create (or refresh) a pending invitation and email the accept link. Owner/admin
 * only (requireFullAccessForAction throws for a member). Validates the role↔client
 * rule and that a member's client belongs to the inviter's tenant. A random token
 * is generated; only its HASH is stored; the RAW token goes in the emailed link.
 * The invite EXISTS regardless of email delivery — if the send fails we say so and
 * return the accept URL so the inviter can copy it as a fallback.
 */
export async function createInvitationAction(input: {
  email: string;
  role: InvitationRole;
  memberClientId?: string | null;
}): Promise<{ ok: boolean; error?: string; emailSent?: boolean; acceptUrl?: string }> {
  const scope = await requireFullAccessForAction(); // owner/admin only

  const email = normalizeEmail(input.email ?? "");
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (input.role !== "admin" && input.role !== "member") {
    return { ok: false, error: "Invalid role." };
  }

  // Role↔client rule + same-tenant client (also enforced by the DB).
  let memberClientId: string | null = null;
  let clientName: string | null = null;
  if (input.role === "member") {
    const clientId = input.memberClientId ?? null;
    if (!clientId) return { ok: false, error: "A member invitation must include a client." };
    const client = await getClientById({ tenantId: scope.tenantId, clientId });
    if (!client) return { ok: false, error: "That client doesn't belong to your workspace." };
    memberClientId = clientId;
    clientName = client.is_default ? "Unassigned" : client.name;
  }

  const rawToken = generateInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  try {
    await createOrReplacePendingInvitation({
      tenantId: scope.tenantId,
      email,
      role: input.role,
      memberClientId,
      tokenHash,
      invitedBy: scope.userId,
      expiresAt,
    });
  } catch {
    return { ok: false, error: "Could not create the invitation." };
  }

  const acceptUrl = `${appBaseUrl()}/invite/accept?token=${rawToken}`;

  // Inviter email + tenant name for the body (the just-created row joins them).
  const session = await getServerSession();
  const created = await getInvitationByTokenHash(tokenHash);
  const tenantName = created?.tenant_name ?? "your workspace";
  const send = await sendEmail({
    to: email,
    subject: `You've been invited to ${tenantName}`,
    html: inviteEmailHtml({
      inviterEmail: session?.user?.email ?? "A teammate",
      tenantName,
      role: input.role,
      clientName,
      acceptUrl,
    }),
  });

  revalidatePath("/settings/team");
  return {
    ok: true,
    emailSent: send.ok,
    acceptUrl, // surfaced so the inviter can copy the link (esp. if email failed)
    error: send.ok ? undefined : `Invitation created, but the email could not be sent (${send.error}). Copy the link below to share it directly.`,
  };
}

/**
 * Accept an invitation by raw token. THE security boundary — re-validates
 * everything (never trusts the caller):
 *  - token hashes to a known PENDING, unexpired invite (generic message otherwise,
 *    no existence leak);
 *  - the caller is signed in AS the invited email (defense-in-depth on top of the
 *    token);
 *  - the user isn't already bound to a DIFFERENT tenant (V1: one tenant per user);
 * then atomically creates the membership in the INVITING tenant + consumes the
 * invite. Returns where to land (member → their client; admin → the Hub).
 */
export async function acceptInvitationAction(
  rawToken: string,
): Promise<{ ok: boolean; error?: string; redirectTo?: string }> {
  if (!rawToken) return { ok: false, error: "This invitation link is invalid or has expired." };

  const invite = await getInvitationByTokenHash(hashInviteToken(rawToken));
  if (!invite) return { ok: false, error: "This invitation link is invalid or has expired." };
  if (invite.status === "accepted") return { ok: false, error: "This invitation has already been used." };
  if (invite.status === "revoked") return { ok: false, error: "This invitation is no longer valid." };
  if (invite.status !== "pending" || invite.expires_at.getTime() <= Date.now()) {
    return { ok: false, error: "This invitation has expired." };
  }

  const session = await getServerSession();
  if (!session?.user?.id) {
    return { ok: false, error: "Please sign in with the invited email to accept this invitation." };
  }
  // Bind to the invited email: the token alone (without controlling that account)
  // is not enough to consume the invite.
  if (normalizeEmail(session.user.email) !== invite.email) {
    return {
      ok: false,
      error: "This invitation was issued for a different email address. Sign in with the invited email to accept it.",
    };
  }

  // V1: a user belongs to ONE tenant (getAccessScope resolves a single membership).
  // If already in a different tenant, refuse rather than create an invisible second
  // membership. (Documented limitation; RBAC may revisit multi-tenant later.)
  const existing = await getMembershipForUser(session.user.id);
  if (existing && existing.tenant_id !== invite.tenant_id) {
    return {
      ok: false,
      error: "This account already belongs to a workspace. Invitations can only be accepted by an account that isn't already in one.",
    };
  }

  let result: "accepted" | "already_member" | "already_used";
  try {
    result = await acceptInvitation({
      invitationId: invite.id,
      tenantId: invite.tenant_id,
      userId: session.user.id,
      role: invite.role,
      memberClientId: invite.member_client_id,
    });
  } catch {
    return { ok: false, error: "Could not accept the invitation. Please try again." };
  }
  if (result === "already_used") {
    return { ok: false, error: "This invitation has already been used." };
  }

  const redirectTo =
    invite.role === "member" && invite.member_client_id
      ? `/clients/${invite.member_client_id}/workflows/all/analytics`
      : "/";
  return { ok: true, redirectTo };
}

/** RBAC-3 wiring: list a tenant's invitations (owner/admin only). No token exposed. */
export async function listInvitationsAction(): Promise<InvitationListRow[]> {
  const scope = await requireFullAccessForAction();
  return listInvitationsForTenant(scope.tenantId);
}

/** RBAC-3 wiring: revoke a pending invitation (owner/admin only, tenant-scoped). */
export async function revokeInvitationAction(
  invitationId: string,
): Promise<{ ok: boolean }> {
  const scope = await requireFullAccessForAction();
  const ok = await revokeInvitation({ tenantId: scope.tenantId, invitationId });
  revalidatePath("/settings/team");
  return { ok };
}
