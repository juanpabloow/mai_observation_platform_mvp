"use server";

import { revalidatePath } from "next/cache";
import { getServerSession } from "./session";
import { getAccessScope, hasFullAccess, requireFullAccessForAction } from "./access";
import { canGrantRole, roleRefOf, type RoleRef } from "./permissions/delegation";
import { SYSTEM_ROLE_LABEL, isSystemRoleKey } from "./permissions/catalog";
import { getAccessRole, getSystemRoleOverride } from "@worker/db/repositories/accessRoles.js";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  getMembershipForUser,
  type ClientRole,
} from "@worker/db/repositories/tenantMembers.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getStaffById } from "@worker/db/repositories/scheduling/staff.js";
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

function roleLabel(
  role: InvitationRole,
  clientName: string | null,
  clientRole: ClientRole | null = null,
  customRoleName: string | null = null,
): string {
  if (clientRole === "owner") return `the owner of ${clientName ?? "a client"}`;
  if (clientRole === "staff") return `staff at ${clientName ?? "a client"}`;
  if (clientRole === "setter") return `a setter at ${clientName ?? "a client"}`;
  if (clientRole === "custom" && customRoleName) return `«${customRoleName}» at ${clientName ?? "a client"}`;
  return role === "member" ? `a member of ${clientName ?? "a client"}` : "an admin";
}

function inviteEmailHtml(params: {
  inviterEmail: string;
  tenantName: string;
  role: InvitationRole;
  clientName: string | null;
  clientRole?: ClientRole | null;
  customRoleName?: string | null;
  acceptUrl: string;
}): string {
  const what = roleLabel(params.role, params.clientName, params.clientRole ?? null, params.customRoleName ?? null);
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
  clientRole?: ClientRole | null;
  accessRoleId?: string | null;
  schedulingSiteId?: string | null;
  schedulingStaffId?: string | null;
}): Promise<{ ok: boolean; error?: string; emailSent?: boolean; acceptUrl?: string }> {
  // Any authenticated user reaches here; the capability to invite THIS role for THIS
  // client is enforced below (agency for admins; access.users.manage + the delegation
  // rules of ./permissions/delegation.ts for a business role). Never trust the caller.
  const scope = await getAccessScope();

  const email = normalizeEmail(input.email ?? "");
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  if (input.role !== "admin" && input.role !== "member") {
    return { ok: false, error: "Invalid role." };
  }
  // ADMIN invites are AGENCY-ONLY and owner-only — a client owner can never mint an
  // admin (that would be a tenant-level escalation), and an admin can't mint an admin.
  if (input.role === "admin") {
    if (!hasFullAccess(scope) || scope.role !== "owner") {
      return { ok: false, error: "Only the workspace owner can invite an admin." };
    }
  }

  let memberClientId: string | null = null;
  let clientName: string | null = null;
  let clientRole: ClientRole | null = null;
  let accessRoleId: string | null = null;
  let customRoleName: string | null = null;
  let schedulingSiteId: string | null = null;
  let schedulingStaffId: string | null = null;
  let grantedRole: RoleRef | null = null;
  if (input.role === "member") {
    const clientId = input.memberClientId ?? null;
    if (!clientId) return { ok: false, error: "A member invitation must include a client." };

    const requestedRole = input.clientRole ?? null;
    if (!isSystemRoleKey(requestedRole) && requestedRole !== "custom") {
      return { ok: false, error: "Elige un rol válido." };
    }
    // The role being offered — a custom one re-read from THIS tenant + business (never
    // the browser's idea of its permissions).
    if (requestedRole === "custom") {
      if (!input.accessRoleId) return { ok: false, error: "Elige un rol." };
      const row = await getAccessRole(scope.tenantId, clientId, input.accessRoleId);
      if (!row) return { ok: false, error: "Ese rol no existe en este negocio." };
      grantedRole = roleRefOf({ client_role: "custom", access_role_id: row.id, role_permissions: row.permissions });
      accessRoleId = row.id;
      customRoleName = row.name;
    } else {
      // A system role as THIS business has it (the agency may have adjusted it).
      grantedRole = roleRefOf({ client_role: requestedRole, system_override: await getSystemRoleOverride(scope.tenantId, clientId, requestedRole) });
    }
    // ESCALATION GATE: may the ACTOR grant this exact role for this exact client?
    // (Deny-by-default; nobody hands out more than they hold, only the agency mints a Dueño.)
    const grant = grantedRole ? canGrantRole(scope, clientId, grantedRole) : { ok: false as const, error: "Elige un rol válido." };
    if (!grant.ok) return { ok: false, error: grant.error };

    const client = await getClientById({ tenantId: scope.tenantId, clientId });
    if (!client) return { ok: false, error: "That client doesn't belong to your workspace." };
    if (client.is_default) return { ok: false, error: "The Unassigned client can't have client roles." };
    memberClientId = clientId;
    clientName = client.name;
    clientRole = requestedRole;

    // Only STAFF carries a site + staff binding; owner/editor see the whole client.
    if (requestedRole === "staff") {
      const siteId = input.schedulingSiteId ?? null;
      if (!siteId) return { ok: false, error: "Choose a site for this staff login." };
      const site = await getSiteById(scope.tenantId, siteId);
      if (!site || site.client_id !== clientId || !site.active) {
        return { ok: false, error: "That site isn't active for the selected client." };
      }
      schedulingSiteId = siteId;
      const staffId = input.schedulingStaffId ?? null;
      if (!staffId) return { ok: false, error: "Choose the staff member for this login." };
      const staff = await getStaffById(scope.tenantId, staffId);
      if (!staff || staff.site_id !== siteId || !staff.active || !staff.takes_bookings) {
        return { ok: false, error: "That staff member isn't bookable at the selected site." };
      }
      schedulingStaffId = staffId;
    }
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
      clientRole,
      accessRoleId,
      schedulingSiteId,
      schedulingStaffId,
      tokenHash,
      invitedBy: scope.userId,
      expiresAt,
      audit: {
        tenantId: scope.tenantId,
        clientId: memberClientId,
        actorUserId: scope.userId,
        actorEmail: (await getServerSession())?.user?.email ?? null,
        action: "invitation.created",
        targetType: "invitation",
        targetLabel: email,
        changes: {
          role: input.role,
          ...(grantedRole
            ? grantedRole.kind === "system"
              ? { clientRole: grantedRole.key, label: SYSTEM_ROLE_LABEL[grantedRole.key] }
              : { clientRole: "custom", accessRoleId, label: customRoleName }
            : {}),
        },
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505" && schedulingStaffId) {
      return { ok: false, error: "That staff profile is already assigned or has a pending invitation." };
    }
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
      clientRole,
      customRoleName,
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
    });
  } catch {
    return { ok: false, error: "Could not accept the invitation. Please try again." };
  }
  if (result === "already_used") {
    return { ok: false, error: "This invitation has already been used." };
  }

  // The same landing the server bounce uses (lib/landing.ts): staff → agenda, setter →
  // inbox, owner → Analytics. A setter used to land on Analytics, which 404s for them.
  // "/" bounces a member to the first page its role opens (access.ts memberLandingHref),
  // computed from the membership just created — one rule for every role, custom included.
  const redirectTo = "/";
  return { ok: true, redirectTo };
}

/** RBAC-3 wiring: list a tenant's invitations (owner/admin only). No token exposed. */
export async function listInvitationsAction(): Promise<InvitationListRow[]> {
  const scope = await requireFullAccessForAction();
  return listInvitationsForTenant(scope.tenantId);
}

/**
 * Revoke a pending invitation. The AGENCY revokes any invite in its tenant; a CLIENT
 * OWNER may revoke ONLY a pending member invite to their OWN client (so they can manage
 * their own pending Editors/Staff). Tenant-scoped throughout — a foreign id never takes
 * effect. Editors/Staff can't reach it.
 */
export async function revokeInvitationAction(
  invitationId: string,
): Promise<{ ok: boolean }> {
  const scope = await getAccessScope();
  const invites = await listInvitationsForTenant(scope.tenantId);
  const target = invites.find((i) => i.id === invitationId);
  if (!target) return { ok: false };
  if (!hasFullAccess(scope)) {
    // A business member revokes only a member invite to ITS business, for a role it
    // could itself grant (access.users.manage + the delegation rules).
    if (target.role !== "member" || !target.member_client_id || target.member_client_id !== scope.memberClientId) {
      return { ok: false };
    }
    let offered: RoleRef | null = null;
    if (target.client_role === "custom" && target.access_role_id) {
      const row = await getAccessRole(scope.tenantId, target.member_client_id, target.access_role_id);
      offered = row ? roleRefOf({ client_role: "custom", access_role_id: row.id, role_permissions: row.permissions }) : null;
    } else {
      offered = roleRefOf({
        client_role: target.client_role,
        system_override: target.client_role && target.client_role !== "custom"
          ? await getSystemRoleOverride(scope.tenantId, target.member_client_id, target.client_role)
          : null,
      });
    }
    if (!offered || !canGrantRole(scope, target.member_client_id, offered).ok) return { ok: false };
  }
  const ok = await revokeInvitation({
    tenantId: scope.tenantId,
    invitationId,
    audit: {
      tenantId: scope.tenantId,
      clientId: target.member_client_id,
      actorUserId: scope.userId,
      actorEmail: (await getServerSession())?.user?.email ?? null,
      action: "invitation.revoked",
      targetType: "invitation",
      targetId: invitationId,
      targetLabel: target.email,
      changes: { clientRole: target.client_role, accessRoleId: target.access_role_id },
    },
  });
  revalidatePath("/settings/team");
  if (scope.memberClientId) revalidatePath(`/clients/${scope.memberClientId}/team`);
  return { ok };
}
