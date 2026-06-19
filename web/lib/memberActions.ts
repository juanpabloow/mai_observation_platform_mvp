"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope, hasFullAccess } from "./access";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  getMemberInTenant,
  removeMemberFromTenant,
  setMembershipRole,
} from "@worker/db/repositories/tenantMembers.js";

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
  revalidatePath("/settings/team");
  return { ok: true };
}
