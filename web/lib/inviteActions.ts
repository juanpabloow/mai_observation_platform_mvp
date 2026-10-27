"use server";

import { revalidatePath } from "next/cache";
import { auth } from "./auth";
import { getServerSession } from "./session";
import { normalizePersonName } from "./personName";
import { INVITE_TTL_DAYS, inviteAccessLabel, inviteBusinessName, inviteEmailHtml } from "./inviteCopy";
import { getAccessScope, hasFullAccess, requireFullAccessForAction } from "./access";
import { canGrantRole, roleRefOf, type RoleRef } from "./permissions/delegation";
import { SYSTEM_ROLE_LABEL, isSystemRoleKey } from "./permissions/catalog";
import { getAccessRole, getSystemRoleOverride } from "@worker/db/repositories/accessRoles.js";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  deleteAuthUserById,
  findUserIdByEmail,
  getMembershipForUser,
  setAuthUserEmailVerified,
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

// Pragmatic email shape check (full RFC validation is overkill; the real proof of
// control is the accept flow requiring the matching signed-in email + the token).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function appBaseUrl(): string {
  return process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
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

  // Business + access + inviter for the body (2a): all from the just-created SERVER row.
  const session = await getServerSession();
  const created = await getInvitationByTokenHash(tokenHash);
  const business = created ? inviteBusinessName(created) : "tu negocio";
  const inviter = session?.user?.name?.trim() || session?.user?.email || "Tu equipo";
  const send = await sendEmail({
    to: email,
    subject: `${inviter} te invitó a ${business}`,
    html: inviteEmailHtml({
      inviter,
      business,
      access: created ? inviteAccessLabel(created) : "miembro",
      email,
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
  if (!rawToken) return { ok: false, error: "Este enlace de invitación no es válido o ya venció." };

  const invite = await getInvitationByTokenHash(hashInviteToken(rawToken));
  if (!invite) return { ok: false, error: "Este enlace de invitación no es válido o ya venció." };
  if (invite.status === "accepted") return { ok: false, error: "Esta invitación ya se usó." };
  if (invite.status === "revoked") return { ok: false, error: "Esta invitación ya no es válida." };
  if (invite.status !== "pending" || invite.expires_at.getTime() <= Date.now()) {
    return { ok: false, error: "Esta invitación venció." };
  }

  const session = await getServerSession();
  if (!session?.user?.id) {
    return { ok: false, error: "Entra con el correo invitado para aceptar la invitación." };
  }
  // Bind to the invited email: the token alone (without controlling that account)
  // is not enough to consume the invite.
  if (normalizeEmail(session.user.email) !== invite.email) {
    return {
      ok: false,
      error: "Esta invitación es para otro correo. Entra con el correo invitado para aceptarla.",
    };
  }

  // V1: a user belongs to ONE tenant (getAccessScope resolves a single membership).
  // If already in a different tenant, refuse rather than create an invisible second
  // membership. (Documented limitation; RBAC may revisit multi-tenant later.)
  const existing = await getMembershipForUser(session.user.id);
  if (existing && existing.tenant_id !== invite.tenant_id) {
    return {
      ok: false,
      error: "Esta cuenta ya pertenece a otro espacio de trabajo y por ahora una cuenta solo puede estar en uno. Pide que te inviten con otro correo.",
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
    return { ok: false, error: "No pudimos aceptar la invitación. Inténtalo otra vez." };
  }
  if (result === "already_used") {
    return { ok: false, error: "Esta invitación ya se usó." };
  }

  // FIX-1: accepting a valid invitation PROVES the user owns this email — the single-use
  // token was delivered only to that inbox AND the signed-in email equals the invited email
  // (both re-checked above). So mark the account email-verified, which lifts an invited
  // email/password user out of the unverified-sign-in limbo. Safe: it is token-gated (never
  // at signup), and verifying the email grants nothing toward Google linking (implicit
  // linking stays OFF), so it does not reopen pre-hijacking. Best-effort — a failure here
  // must not undo the membership that was just created.
  try {
    await setAuthUserEmailVerified(session.user.id);
  } catch {
    // Non-fatal: the user is a member; verification can still be completed via the email link.
  }

  // The same landing the server bounce uses (lib/landing.ts): staff → agenda, setter →
  // inbox, owner → Analytics. A setter used to land on Analytics, which 404s for them.
  // "/" bounces a member to the first page its role opens (access.ts memberLandingHref),
  // computed from the membership just created — one rule for every role, custom included.
  const redirectTo = "/";
  return { ok: true, redirectTo };
}

/**
 * 5a «Crear perfil» with a PASSWORD, for someone who has no account yet. One server step:
 *  1. re-validate the token (pending, unexpired) — the invitation fixes the email, business
 *     and role; the browser only sends a name, a password and the «Mantener sesión» choice;
 *  2. refuse when an account already exists for that email (that person signs in and
 *     accepts — never a second account, never a second password);
 *  3. create the user THROUGH Better Auth's internal adapter (its password hasher, its
 *     user-create hook — which sees the pending invite and provisions no personal tenant),
 *     with the email VERIFIED: the single-use token was delivered only to that inbox, the
 *     same proof FIX-1 already relies on when accepting;
 *  4. consume the invite + create the membership (one transaction, single-use); if the
 *     invite was consumed meanwhile, the just-created user is removed again;
 *  5. the BROWSER then signs in through Better Auth's normal email endpoint (exactly the
 *     /login path: same session policy hooks, same cookies). Signing in from inside this
 *     action would set the cookie mid-render and re-render the page with the old request
 *     headers, i.e. without the new session.
 * The password is never logged, stored by us or echoed back.
 */
export async function createProfileFromInvitationAction(input: {
  token: string;
  name: string;
  password: string;
}): Promise<{ ok: true; email: string } | { ok: false; error: string; field?: "name" | "password"; code?: "exists" | "invalid" }> {
  const invite = input.token ? await getInvitationByTokenHash(hashInviteToken(input.token)) : null;
  if (!invite || invite.status !== "pending" || invite.expires_at.getTime() <= Date.now()) {
    return { ok: false, code: "invalid", error: "Esta invitación ya no es válida. Pide una nueva a quien te invitó." };
  }
  const name = normalizePersonName(input.name);
  if (!name.ok) return { ok: false, field: "name", error: name.error };
  const password = typeof input.password === "string" ? input.password : "";
  if (password.length < 8) return { ok: false, field: "password", error: "Usa al menos 8 caracteres." };
  if (password.length > 128) return { ok: false, field: "password", error: "Usa como máximo 128 caracteres." };

  if (await findUserIdByEmail(invite.email)) {
    return { ok: false, code: "exists", error: "Ya tienes una cuenta con este correo. Inicia sesión para aceptar la invitación." };
  }

  const ctx = await auth.$context;
  let userId: string;
  try {
    const hash = await ctx.password.hash(password);
    const user = await ctx.internalAdapter.createUser({ email: invite.email, name: name.name, emailVerified: true });
    userId = user.id;
    await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
  } catch {
    // Most likely a concurrent creation of the same email (unique violation).
    return { ok: false, code: "exists", error: "Ya tienes una cuenta con este correo. Inicia sesión para aceptar la invitación." };
  }

  let accepted: "accepted" | "already_member" | "already_used";
  try {
    accepted = await acceptInvitation({ invitationId: invite.id, tenantId: invite.tenant_id, userId });
  } catch {
    accepted = "already_used";
  }
  if (accepted === "already_used") {
    await deleteAuthUserById(userId).catch(() => {});
    return { ok: false, code: "invalid", error: "Esta invitación ya se usó. Pide una nueva a quien te invitó." };
  }

  return { ok: true, email: invite.email };
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
