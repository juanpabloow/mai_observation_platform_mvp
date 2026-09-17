"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope, hasFullAccess } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import { releaseAgentConversations } from "@worker/db/repositories/handoff.js";
import {
  getMemberInTenant,
  removeMemberFromTenant,
  setMemberSchedulingAccess,
  setMembershipRole,
  type SchedulingAccess,
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
 * Member-management actions (RBAC-3). All owner/admin-only and tenant-scoped; they
 * enforce the SAME constraints as RBAC-1 (role↔client, same-tenant client) plus the
 * owner-vs-admin boundary — server-side, never just hidden in the UI:
 *
 *  - The OWNER row is IMMUTABLE to everyone (no demote/remove/reassign; owner
 *    transfer is out of scope). This is also the last-owner / sole-owner guard:
 *    a tenant can never be left ownerless.
 *  - Managing the ADMIN tier — promoting a member to admin, or changing/removing an
 *    existing admin — is OWNER-ONLY.
 *  - ADMINS manage MEMBERS: reassign a member's client, remove a member. (Inviting
 *    admins is likewise owner-only; see createInvitationAction.)
 *
 * Members can't reach these (hasFullAccess is false for them) — they get a clean
 * permission error rather than a thrown 500.
 */

type Result = { ok: boolean; error?: string };

const PERMISSION_DENIED = "You don't have permission to manage members.";

/**
 * Change a member's role. member→admin (promote) and any change touching an
 * existing admin are owner-only; the owner row can't be changed. Enforces
 * role↔client (becoming a member requires an in-tenant client; becoming an admin
 * clears it).
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
  // role↔client rule.
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
    });
    if (updated === 0) return { ok: false, error: "Member not found." };
  } catch {
    return { ok: false, error: "Could not update the member." };
  }
  // Orphan release: becoming a member narrows access to a single client. Release any
  // 'human' conversations this user holds in clients they can NO LONGER reach (every
  // client except the one they're now scoped to). Covers admin→member demotion and a
  // member→member re-scope; member→admin (a widening) never reaches here.
  if (input.newRole === "member" && memberClientId) {
    await releaseOrphanedConversations(scope.tenantId, input.targetUserId, {
      exceptClientId: memberClientId,
    });
  }
  revalidatePath("/settings/team");
  return { ok: true };
}

/** Reassign which client a MEMBER is scoped to (must be a member; client in-tenant). */
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
  const client = await getClientById({ tenantId: scope.tenantId, clientId: input.clientId });
  if (!client) return { ok: false, error: "That client isn't in your workspace." };
  const oldClientId = target.member_client_id; // the client they're leaving
  try {
    await setMembershipRole({
      tenantId: scope.tenantId,
      userId: input.targetUserId,
      role: "member",
      memberClientId: input.clientId,
    });
  } catch {
    return { ok: false, error: "Could not reassign the client." };
  }
  // Orphan release (client-scoped): the member left their old client, so re-queue any
  // 'human' conversations they held THERE. Their new client's conversations are
  // untouched. Skip when the reassign is a no-op (same client).
  if (oldClientId && oldClientId !== input.clientId) {
    await releaseOrphanedConversations(scope.tenantId, input.targetUserId, { clientId: oldClientId });
  }
  revalidatePath("/settings/team");
  return { ok: true };
}

/**
 * Assign or remove the member's scheduling profile. This is an owner/admin-only
 * mutation and every supplied id is resolved server-side before the DB's
 * composite foreign keys enforce the same boundary again.
 */
export async function setMemberSchedulingAccessAction(input: {
  targetUserId: string;
  clientId: string;
  access: SchedulingAccess | null;
  siteId?: string | null;
  staffId?: string | null;
}): Promise<Result> {
  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) return { ok: false, error: PERMISSION_DENIED };
  if (input.access !== null && input.access !== "staff" && input.access !== "reception") {
    return { ok: false, error: "Invalid scheduling access." };
  }

  const target = await getMemberInTenant(scope.tenantId, input.targetUserId);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role !== "member" || target.member_client_id !== input.clientId) {
    return { ok: false, error: "Scheduling access can only be assigned to a member of this client." };
  }

  let siteId: string | null = null;
  let staffId: string | null = null;
  if (input.access) {
    siteId = input.siteId ?? null;
    if (!siteId) return { ok: false, error: "Choose a site." };
    const site = await getSiteById(scope.tenantId, siteId);
    if (!site || site.client_id !== input.clientId || !site.active) {
      return { ok: false, error: "That site isn't active for this client." };
    }
    if (input.access === "staff") {
      staffId = input.staffId ?? null;
      if (!staffId) return { ok: false, error: "Choose the staff member for this login." };
      const staff = await getStaffById(scope.tenantId, staffId);
      if (!staff || staff.site_id !== siteId || !staff.active || !staff.takes_bookings) {
        return { ok: false, error: "That staff member isn't bookable at the selected site." };
      }
    }
  }

  try {
    const updated = await setMemberSchedulingAccess({
      tenantId: scope.tenantId,
      userId: input.targetUserId,
      clientId: input.clientId,
      access: input.access,
      siteId,
      staffId,
    });
    if (updated === 0) return { ok: false, error: "Member not found." };
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      return { ok: false, error: "That staff profile is already linked to another login." };
    }
    return { ok: false, error: "Could not update scheduling access." };
  }

  revalidatePath(`/clients/${input.clientId}/team`);
  revalidatePath("/settings/team");
  return { ok: true };
}

/**
 * Remove a member's access. The owner can never be removed (immutable / last-owner
 * guard); removing an admin is owner-only. So an admin can't remove the owner,
 * another admin, or themselves (no self-lockout).
 */
export async function removeMemberAction(input: { targetUserId: string }): Promise<Result> {
  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) return { ok: false, error: PERMISSION_DENIED };
  const target = await getMemberInTenant(scope.tenantId, input.targetUserId);
  if (!target) return { ok: false, error: "Member not found." };
  if (target.role === "owner") {
    return { ok: false, error: "The workspace owner can't be removed." };
  }
  if (target.role === "admin" && scope.role !== "owner") {
    return { ok: false, error: "Only the owner can remove an admin." };
  }
  const ok = await removeMemberFromTenant({ tenantId: scope.tenantId, userId: input.targetUserId });
  if (!ok) return { ok: false, error: "Could not remove the member." };
  // Orphan release (tenant-wide): the removed user can no longer act on ANY of their
  // 'human' conversations across the tenant — re-queue them all.
  await releaseOrphanedConversations(scope.tenantId, input.targetUserId);
  revalidatePath("/settings/team");
  return { ok: true };
}
