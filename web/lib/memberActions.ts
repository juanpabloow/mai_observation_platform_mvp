"use server";

import { revalidatePath } from "next/cache";
import { canManageClient, getAccessScope, hasFullAccess } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import { releaseAgentConversations } from "@worker/db/repositories/handoff.js";
import {
  countClientOwners,
  getMemberInTenant,
  removeMemberFromTenant,
  setMemberClientRole,
  setMembershipRole,
  type ClientRole,
} from "@worker/db/repositories/tenantMembers.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getStaffById } from "@worker/db/repositories/scheduling/staff.js";

/**
 * ORPHAN RELEASE (H-2). After a member loses access to conversations they were
 * assigned to, re-queue their live 'human' handoff conversations so no customer is
 * stranded. Best-effort: it must NEVER fail the membership change that already
 * committed, so any error is swallowed (the repo is itself per-conversation safe).
 */
async function releaseOrphanedConversations(
  tenantId: string,
  userId: string,
  opts: { clientId?: string; exceptClientId?: string } = {},
): Promise<void> {
  try {
    await releaseAgentConversations(tenantId, userId, opts);
  } catch {
    /* best-effort — the membership change is the source of truth */
  }
}

/**
 * Member-management actions. TWO tiers, enforced server-side (never just hidden):
 *
 *  AGENCY tier (tenant owner/admin, hasFullAccess) manages the TENANT role
 *  (admin↔member) and which client a member belongs to. The OWNER row is immutable;
 *  managing an admin is owner-only.
 *
 *  CLIENT tier (a Client Owner, or the agency) manages the CLIENT ROLE of the people
 *  who work at a client — owner/editor/staff. The escalation invariants:
 *    - only the AGENCY may create/assign a Client Owner (a Client Owner can't mint
 *      Owners — that would make an account takeover self-propagating);
 *    - a Client Owner acts ONLY within their own client, and ONLY on editors/staff;
 *    - the LAST Client Owner of a client can never be demoted or removed;
 *    - no one escalates by acting on themselves (a Client Owner is an Owner, so the
 *      "can't touch an Owner" rule already blocks self-demote/removal).
 */

type Result = { ok: boolean; error?: string };

const PERMISSION_DENIED = "You don't have permission to manage members.";
const LAST_OWNER = "This is the client's only Owner. Assign another Owner first.";

/**
 * Change a member's TENANT role (admin↔member) — AGENCY only. member→admin and any
 * change touching an admin are owner-only; the owner row can't be changed. Becoming a
 * member lands them as an 'editor' by default (the agency then promotes to Owner on the
 * client's team page if needed).
 */
export async function changeMemberRoleAction(input: {
  targetUserId: string;
  newRole: "admin" | "member";
  memberClientId?: string | null;
}): Promise<Result> {
  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) return { ok: false, error: PERMISSION_DENIED };
  if (input.newRole !== "admin" && input.newRole !== "member") {
    return { ok: false, error: "Invalid role." };
  }
  const target = await getMemberInTenant(scope.tenantId, input.targetUserId);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role === "owner") {
    return { ok: false, error: "The workspace owner's role can't be changed." };
  }
  // Managing the admin tier is owner-only (promoting to admin OR touching an admin).
  if ((input.newRole === "admin" || target.role === "admin") && scope.role !== "owner") {
    return { ok: false, error: "Only the owner can change admin roles." };
  }
  let memberClientId: string | null = null;
  if (input.newRole === "member") {
    const clientId = input.memberClientId ?? null;
    if (!clientId) return { ok: false, error: "Assign a client when making someone a member." };
    const client = await getClientById({ tenantId: scope.tenantId, clientId });
    if (!client) return { ok: false, error: "That client isn't in your workspace." };
    memberClientId = clientId;
  }
  try {
    const updated = await setMembershipRole({
      tenantId: scope.tenantId,
      userId: input.targetUserId,
      role: input.newRole,
      memberClientId,
      clientRole: "setter",
    });
    if (updated === 0) return { ok: false, error: "Member not found." };
  } catch {
    return { ok: false, error: "Could not update the member." };
  }
  if (input.newRole === "member" && memberClientId) {
    await releaseOrphanedConversations(scope.tenantId, input.targetUserId, {
      exceptClientId: memberClientId,
    });
  }
  revalidatePath("/settings/team");
  return { ok: true };
}

/** Reassign which client a MEMBER belongs to — AGENCY only. A staff login carries a
 *  site/staff binding to its current client, so it can't be moved here (change its role
 *  on the client's team page first); owner/editor keep their client role. */
export async function reassignMemberClientAction(input: {
  targetUserId: string;
  clientId: string;
}): Promise<Result> {
  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) return { ok: false, error: PERMISSION_DENIED };
  const target = await getMemberInTenant(scope.tenantId, input.targetUserId);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role !== "member") {
    return { ok: false, error: "Only members are scoped to a client." };
  }
  if (target.client_role === "staff") {
    return { ok: false, error: "Change a staff login's role before moving it to another client." };
  }
  const client = await getClientById({ tenantId: scope.tenantId, clientId: input.clientId });
  if (!client) return { ok: false, error: "That client isn't in your workspace." };
  const oldClientId = target.member_client_id;
  try {
    await setMembershipRole({
      tenantId: scope.tenantId,
      userId: input.targetUserId,
      role: "member",
      memberClientId: input.clientId,
      clientRole: target.client_role === "owner" ? "owner" : "setter",
    });
  } catch {
    return { ok: false, error: "Could not reassign the client." };
  }
  if (oldClientId && oldClientId !== input.clientId) {
    await releaseOrphanedConversations(scope.tenantId, input.targetUserId, { clientId: oldClientId });
  }
  revalidatePath("/settings/team");
  return { ok: true };
}

/**
 * Set a member's CLIENT ROLE (owner | setter | staff) within their client. The agency
 * or the client's Owner may run it; only the agency may assign 'owner'; the last Owner
 * can't be demoted. `staff` requires a site + staff binding, validated here before the
 * DB's composite foreign keys enforce it again.
 */
export async function changeClientRoleAction(input: {
  targetUserId: string;
  clientId: string;
  clientRole: ClientRole;
  siteId?: string | null;
  staffId?: string | null;
}): Promise<Result> {
  const scope = await getAccessScope();
  if (!canManageClient(scope, input.clientId)) return { ok: false, error: PERMISSION_DENIED };
  if (input.clientRole !== "owner" && input.clientRole !== "setter" && input.clientRole !== "staff") {
    return { ok: false, error: "Invalid role." };
  }
  // Only the AGENCY may create/assign a Client Owner.
  if (input.clientRole === "owner" && !hasFullAccess(scope)) {
    return { ok: false, error: "Only the agency can make someone an Owner." };
  }
  const target = await getMemberInTenant(scope.tenantId, input.targetUserId);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role !== "member" || target.member_client_id !== input.clientId) {
    return { ok: false, error: "That person isn't a member of this client." };
  }
  // A Client Owner may act only on editors/staff — never on another Owner (that tier is
  // the agency's), which also blocks them acting on themselves.
  if (!hasFullAccess(scope) && target.client_role === "owner") {
    return { ok: false, error: "Only the agency can change an Owner." };
  }
  // Never demote the LAST Client Owner (would leave the client with no admin).
  if (target.client_role === "owner" && input.clientRole !== "owner") {
    const owners = await countClientOwners(scope.tenantId, input.clientId);
    if (owners <= 1) return { ok: false, error: LAST_OWNER };
  }

  let siteId: string | null = null;
  let staffId: string | null = null;
  if (input.clientRole === "staff") {
    siteId = input.siteId ?? null;
    if (!siteId) return { ok: false, error: "Choose a site." };
    const site = await getSiteById(scope.tenantId, siteId);
    if (!site || site.client_id !== input.clientId || !site.active) {
      return { ok: false, error: "That site isn't active for this client." };
    }
    staffId = input.staffId ?? null;
    if (!staffId) return { ok: false, error: "Choose the staff member for this login." };
    const staff = await getStaffById(scope.tenantId, staffId);
    if (!staff || staff.site_id !== siteId || !staff.active || !staff.takes_bookings) {
      return { ok: false, error: "That staff member isn't bookable at the selected site." };
    }
  }

  try {
    const updated = await setMemberClientRole({
      tenantId: scope.tenantId,
      userId: input.targetUserId,
      clientId: input.clientId,
      clientRole: input.clientRole,
      siteId,
      staffId,
    });
    if (updated === 0) return { ok: false, error: "Member not found." };
  } catch (error) {
    // The real error is logged server-side (never shown to the user); the member sees a
    // specific, human-readable reason for the known Postgres failure classes instead of a
    // blank "Could not update the role."
    const code = (error as { code?: string }).code;
    console.error("changeClientRoleAction failed", { clientRole: input.clientRole, code, error });
    if (code === "23505") {
      return { ok: false, error: "That staff profile is already linked to another login." };
    }
    if (code === "23514") {
      // A CHECK rejected the combination (e.g. a role the database doesn't allow, or a
      // staff role missing its site/staff binding).
      return { ok: false, error: "That role isn't allowed for this member. Pick Owner, Setter or Staff (Staff needs a site and a staff profile)." };
    }
    if (code === "23503") {
      // A foreign key rejected the site/staff — not part of this client.
      return { ok: false, error: "That site or staff member isn't part of this client." };
    }
    return { ok: false, error: "Could not update the role. Please try again." };
  }

  // Dropping to staff removes CRM/inbox reach — release any conversations they held here.
  if (input.clientRole === "staff") {
    await releaseOrphanedConversations(scope.tenantId, input.targetUserId, { clientId: input.clientId });
  }
  revalidatePath(`/clients/${input.clientId}/team`);
  revalidatePath("/settings/team");
  return { ok: true };
}

/**
 * Remove a member's access. The workspace owner is immutable; removing a tenant admin is
 * agency-owner-only. A client member (owner/editor/staff) may be removed by the agency
 * OR by that client's Owner — but only the agency may remove a Client Owner, and never
 * the last one.
 */
export async function removeMemberAction(input: { targetUserId: string }): Promise<Result> {
  const scope = await getAccessScope();
  const target = await getMemberInTenant(scope.tenantId, input.targetUserId);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role === "owner") {
    return { ok: false, error: "The workspace owner can't be removed." };
  }
  if (target.role === "admin") {
    if (scope.role !== "owner") return { ok: false, error: "Only the owner can remove an admin." };
  } else {
    // A client member: the agency or the client's Owner may remove editors/staff.
    const clientId = target.member_client_id;
    if (!clientId || !canManageClient(scope, clientId)) return { ok: false, error: PERMISSION_DENIED };
    if (target.client_role === "owner") {
      if (!hasFullAccess(scope)) return { ok: false, error: "Only the agency can remove an Owner." };
      const owners = await countClientOwners(scope.tenantId, clientId);
      if (owners <= 1) return { ok: false, error: LAST_OWNER };
    }
  }
  const ok = await removeMemberFromTenant({ tenantId: scope.tenantId, userId: input.targetUserId });
  if (!ok) return { ok: false, error: "Could not remove the member." };
  // Orphan release (tenant-wide): the removed user can no longer act on ANY of their
  // 'human' conversations across the tenant — re-queue them all.
  await releaseOrphanedConversations(scope.tenantId, input.targetUserId);
  revalidatePath("/settings/team");
  if (target.member_client_id) revalidatePath(`/clients/${target.member_client_id}/team`);
  return { ok: true };
}
