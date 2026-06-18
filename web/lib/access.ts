import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "./session";
import { requireTenant } from "./requireAuth";
import {
  getMembershipForUser,
  type MembershipScopeRow,
} from "@worker/db/repositories/tenantMembers.js";

/**
 * THE within-tenant authorization core (RBAC-1). Tenant isolation decides which
 * TENANT a request belongs to (getCurrentTenantId / requireTenant); this layer
 * decides which CLIENTS' data a user may see INSIDE that tenant. Every
 * client/workflow/execution/conversation/analytics path consults it.
 *
 *  - owner / admin → FULL data access (memberClientId === null, i.e. "all
 *    clients"). For RBAC-1 the two are equivalent for data; admin vs owner only
 *    diverges for owner-only actions in later steps.
 *  - member         → exactly ONE client (memberClientId) and NOTHING else.
 *
 * The scope is resolved from the SESSION at the data layer — the URL is never
 * trusted. Resolution FAILS CLOSED: an unknown role, or a 'member' with no
 * client (a state the DB CHECK forbids), yields no access rather than silently
 * widening to all clients.
 */

export type Role = "owner" | "admin" | "member";

export interface AccessScope {
  tenantId: string;
  userId: string;
  role: Role;
  /** null = all clients (owner/admin); otherwise the single client a member sees. */
  memberClientId: string | null;
}

/** owner/admin — full data access, no per-client restriction. */
export function hasFullAccess(scope: AccessScope): boolean {
  return scope.memberClientId === null;
}

/**
 * Deny-by-default client predicate: may this scope see this client? Tenant
 * scoping is assumed already applied (clientId must be a validated tenant client);
 * here owner/admin see any of THEIR clients, a member only their one client.
 */
export function canAccessClient(scope: AccessScope, clientId: string): boolean {
  return scope.memberClientId === null || scope.memberClientId === clientId;
}

/**
 * A member's home / bounce target when they hit a full-access-only surface (the
 * tenant Hub `/`, the Clients & Workflows management view, settings): their ONE
 * client's aggregate ("All workflows") analytics. That URL is always valid (it
 * renders an empty state when the client has no workflows yet) and is a
 * workflow-LEVEL route, so the sidebar shows workflow nav rather than the Hub.
 * owner/admin → the Hub.
 */
export function memberLandingHref(scope: AccessScope): string {
  return scope.memberClientId
    ? `/clients/${scope.memberClientId}/workflows/all/analytics`
    : "/";
}

type ScopeResult = { ok: true; scope: AccessScope } | { ok: false };

/** Build a validated scope from a membership row, or fail closed. */
function buildScope(userId: string, membership: MembershipScopeRow | null): ScopeResult {
  if (!membership) return { ok: false };
  const role = membership.role;
  // Unknown role → deny (never default to full access). The DB CHECK keeps role
  // in {owner,admin,member}; this guard is the code-side belt to that DB belt.
  if (role !== "owner" && role !== "admin" && role !== "member") return { ok: false };
  const memberClientId = role === "member" ? membership.member_client_id : null;
  // A 'member' with no client is a broken/forbidden state (the DB forbids it):
  // deny rather than treat a missing client as "see everything".
  if (role === "member" && !memberClientId) return { ok: false };
  return {
    ok: true,
    scope: { tenantId: membership.tenant_id, userId, role, memberClientId },
  };
}

/**
 * THE authority for DATA pages / Server Actions / resolvers. Like requireTenant
 * it redirects (to /login) when there's no session/tenant, and additionally
 * fails closed (also a redirect) when the membership can't yield a valid scope —
 * so a caller can always trust the returned scope. Cached per request so the
 * many consults in one render share a single pair of queries.
 */
export const getAccessScope = cache(async (): Promise<AccessScope> => {
  const { userId } = await requireTenant(); // redirects on no session / no tenant
  const membership = await getMembershipForUser(userId);
  const result = buildScope(userId, membership);
  if (!result.ok) redirect("/login?error=forbidden");
  return result.scope;
});

/**
 * Non-redirecting variant for LAYOUT CHROME (the header + sidebar), which must
 * render gracefully (null) when logged out / scope-less rather than redirect.
 * Returns null in exactly the cases getAccessScope would redirect. Cached so the
 * header and sidebar share one pair of queries.
 */
export const getSessionScope = cache(async (): Promise<AccessScope | null> => {
  const session = await getServerSession();
  if (!session?.user?.id) return null;
  const membership = await getMembershipForUser(session.user.id);
  const result = buildScope(session.user.id, membership);
  return result.ok ? result.scope : null;
});

/**
 * Owner/admin-only PAGE guard. Returns the scope for full-access users; sends a
 * member to their own client's context (they have no Hub / management / settings).
 * Used by `/`, `/clients`, and `/settings/*`.
 */
export async function requireFullAccessOrLand(): Promise<AccessScope> {
  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) redirect(memberLandingHref(scope));
  return scope;
}

/**
 * Owner/admin-only SERVER-ACTION guard. Throws (a redirect is wrong for a
 * mutation) so a member can never run a full-access action (client management).
 */
export async function requireFullAccessForAction(): Promise<AccessScope> {
  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) {
    throw new Error("Forbidden: this action requires owner or admin access.");
  }
  return scope;
}
