import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "./session";
import { memberLandingPath } from "./landing";
import { requireTenant } from "./requireAuth";
import {
  getMembershipForUser,
  type MembershipScopeRow,
  type ClientRole,
} from "@worker/db/repositories/tenantMembers.js";
import {
  AGENCY_PERMISSIONS,
  SYSTEM_ROLE_LABEL,
  SYSTEM_ROLE_PERMISSIONS,
  type SystemRoleKey,
  missingRequirements,
  sanitizeBusinessPermissions,
  type PermissionKey,
} from "./permissions/catalog";

/**
 * THE within-tenant authorization core. Tenant isolation decides which TENANT a request
 * belongs to (getCurrentTenantId / requireTenant); this layer decides, INSIDE that tenant,
 * WHAT a login may do (its PERMISSIONS) and ON WHAT (its SCOPE):
 *
 *     effective access = module enabled  ∧  permission  ∧  scope
 *
 * PERMISSIONS come from the role, read through the catalog (./permissions/catalog.ts):
 *  - agency (tenant owner/admin) → AGENCY_PERMISSIONS on every client of the tenant;
 *  - a member with a SYSTEM role (Dueño = owner, Recepción = setter, Profesional = staff)
 *    → SYSTEM_ROLE_PERMISSIONS, defined in code;
 *  - a member with a CUSTOM role (client_role = 'custom') → the role's stored keys, minus
 *    anything unknown, agency-only or missing its requirement (deny by default).
 * Nothing here — or anywhere — branches on a role's NAME.
 *
 * SCOPE comes from the membership, never from the request:
 *  - agency: every client of the tenant (callers still prove the client is in the tenant);
 *  - member: exactly ONE client (memberClientId);
 *  - a professional login is further bound to one site + one staff column
 *    (schedulingSiteId / schedulingStaffId): it sees its site, writes only its column.
 *
 * Resolution FAILS CLOSED: an unknown role, a member with no client, an inconsistent
 * role/binding, or a custom role that doesn't resolve yields no access at all.
 *
 * FRESHNESS: the membership (and its role's permissions) is re-read on EVERY request —
 * React's cache() only dedupes within one render — so a change applies on the next request
 * of the affected login, with no logout and no authorization cache to invalidate.
 */

export type Role = "owner" | "admin" | "member";

export interface AccessScope {
  tenantId: string;
  userId: string;
  role: Role;
  /** null = all clients (owner/admin); otherwise the single client a member sees. */
  memberClientId: string | null;
  /** The membership's client role — non-null iff role === "member" ('custom' = custom role). */
  clientRole: ClientRole | null;
  /** Non-null iff the member is a professional login (the one staff resource + its site). */
  schedulingSiteId: string | null;
  schedulingStaffId: string | null;
  /** Non-null iff clientRole === "custom". */
  accessRoleId: string | null;
  /** The role's display name: a system role's label, a custom role's name; null = agency. */
  roleLabel: string | null;
  /** What this login may do — on memberClientId, or (agency) on any client of the tenant. */
  permissions: ReadonlySet<PermissionKey>;
}

/** The message a refused action shows when the login is in the right business but lacks
 *  the permission (e.g. it was revoked while the screen was open). Safe to be specific:
 *  it only ever reaches someone already inside that business. */
export const NO_PERMISSION = "Ya no tienes permiso para hacer esto. Si lo necesitas, pídeselo a quien administra los accesos de tu negocio.";

/** owner/admin — the AGENCY tier: every client of the tenant, plus agency-only surfaces. */
export function hasFullAccess(scope: AccessScope): boolean {
  return scope.memberClientId === null;
}

/** Is this client inside the login's scope? Agency: any client (of its tenant — the caller
 *  proves that with a tenant-scoped lookup); member: only its own. */
export function inClientScope(scope: AccessScope, clientId: string): boolean {
  return scope.memberClientId === null || scope.memberClientId === clientId;
}

/** THE permission predicate: may this login do `key` on this client? */
export function can(scope: AccessScope, key: PermissionKey, clientId: string): boolean {
  return inClientScope(scope, clientId) && scope.permissions.has(key);
}

/** Any of `keys` on this client (for surfaces that serve several capabilities). */
export function canAny(scope: AccessScope, keys: readonly PermissionKey[], clientId: string): boolean {
  return inClientScope(scope, clientId) && keys.some((k) => scope.permissions.has(k));
}

/**
 * The permissions that open a WORKFLOW-level surface of a client — the workflow inbox
 * transcript (inbox.view), its executions/settings (automations.view) and its analytics
 * (analytics.view). Resolving a workflow under a client needs one of them; each page then
 * gates on its own (requireWorkflowInsights for executions/analytics/settings).
 */
export const WORKFLOW_SURFACE_PERMISSIONS: readonly PermissionKey[] = ["inbox.view", "automations.view", "analytics.view"];

/**
 * The holder of the protected DUEÑO system role on this client. Not a capability check —
 * it identifies the PROTECTED tier: only the agency may grant or take it, and the last one
 * of a client can never be removed. Capabilities always go through can().
 */
export function isClientOwner(scope: AccessScope, clientId: string): boolean {
  return scope.role === "member" && scope.clientRole === "owner" && scope.memberClientId === clientId;
}

/** A professional login — bound to one staff resource at one site. A SCOPE fact (which
 *  agenda), not a capability: what it may do there still comes from its permissions. */
export function isSchedulingStaff(scope: AccessScope): boolean {
  return scope.schedulingStaffId !== null;
}

/** Site predicate for scheduling pages and every scheduling Server Action. A professional
 *  login is pinned to its one site; everyone else works on the whole client. */
export function canAccessSchedulingSite(scope: AccessScope, siteId: string): boolean {
  if (isSchedulingStaff(scope)) return scope.schedulingSiteId === siteId;
  return true;
}

/** Column predicate for appointment WRITES: a professional login may only create/modify
 *  appointments in its OWN column; everyone else on any staff of a site they can access. */
export function canAccessSchedulingStaff(scope: AccessScope, staffId: string): boolean {
  if (isSchedulingStaff(scope)) return scope.schedulingStaffId === staffId;
  return true;
}

/**
 * A member's home / bounce target when they hit an agency-only surface (the tenant Hub
 * `/`, Clients, settings): the first page their permissions open (lib/landing.ts).
 * owner/admin → the Hub.
 */
export function memberLandingHref(scope: AccessScope): string {
  if (scope.memberClientId) {
    return memberLandingPath(scope.memberClientId, { permissions: scope.permissions, staffBound: isSchedulingStaff(scope) });
  }
  return "/";
}

/** Drop, until stable, every key whose requirement is not held — a stored role that is
 *  not dependency-closed never grants the dependent permission (deny by default). */
function closeOverRequirements(keys: Set<PermissionKey>): Set<PermissionKey> {
  let missing = missingRequirements(keys);
  while (missing.length) {
    for (const m of missing) keys.delete(m.key);
    missing = missingRequirements(keys);
  }
  return keys;
}

type ScopeResult = { ok: true; scope: AccessScope } | { ok: false };

/** Build a validated scope from a membership row, or fail closed. */
export function buildScope(userId: string, membership: MembershipScopeRow | null): ScopeResult {
  if (!membership) return { ok: false };
  const role = membership.role;
  // Unknown role → deny (never default to full access). The DB CHECK keeps role
  // in {owner,admin,member}; this guard is the code-side belt to that DB belt.
  if (role !== "owner" && role !== "admin" && role !== "member") return { ok: false };
  const memberClientId = role === "member" ? membership.member_client_id : null;
  // A 'member' with no client is a broken/forbidden state (the DB forbids it):
  // deny rather than treat a missing client as "see everything".
  if (role === "member" && !memberClientId) return { ok: false };

  const clientRole = role === "member" ? membership.client_role : null;
  const schedulingSiteId = role === "member" ? membership.scheduling_site_id : null;
  const schedulingStaffId = role === "member" ? membership.scheduling_staff_id : null;
  const accessRoleId = role === "member" ? (membership.access_role_id ?? null) : null;

  // A non-member carries no client role, binding or custom role (mirrors the DB CHECK).
  if (role !== "member" && (membership.client_role !== null || membership.access_role_id)) return { ok: false };

  let permissions: ReadonlySet<PermissionKey>;
  if (role !== "member") {
    permissions = AGENCY_PERMISSIONS;
  } else if (clientRole === "owner" || clientRole === "setter" || clientRole === "staff") {
    if (accessRoleId !== null) return { ok: false };
    permissions = SYSTEM_ROLE_PERMISSIONS[clientRole];
  } else if (clientRole === "custom") {
    // The custom role must resolve (same tenant + client, enforced by the composite FK and
    // re-checked by the join in getMembershipForUser); otherwise fail closed.
    if (!accessRoleId || !membership.access_role_name || !Array.isArray(membership.role_permissions)) return { ok: false };
    permissions = closeOverRequirements(sanitizeBusinessPermissions(membership.role_permissions));
  } else {
    return { ok: false }; // unknown / absent client role → deny
  }

  // The site/staff binding exists iff the member is a professional login (mirrors the DB
  // CHECK, which only allows it on the Profesional system role).
  if (
    (clientRole === "staff" && (!schedulingSiteId || !schedulingStaffId)) ||
    (clientRole !== "staff" && (schedulingSiteId !== null || schedulingStaffId !== null))
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    scope: {
      tenantId: membership.tenant_id,
      userId,
      role,
      memberClientId,
      clientRole,
      schedulingSiteId,
      schedulingStaffId,
      accessRoleId,
      roleLabel:
        role !== "member"
          ? null
          : clientRole === "custom"
            ? (membership.access_role_name as string)
            : SYSTEM_ROLE_LABEL[clientRole as SystemRoleKey],
      permissions,
    },
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
