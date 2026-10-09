import { cache } from "react";
import { redirect } from "next/navigation";
import { getServerSession } from "./session";
import { requireTenant } from "./requireAuth";
import {
  getMembershipForUser,
  type MembershipScopeRow,
  type ClientRole,
} from "@worker/db/repositories/tenantMembers.js";

/**
 * THE within-tenant authorization core (RBAC-1). Tenant isolation decides which
 * TENANT a request belongs to (getCurrentTenantId / requireTenant); this layer
 * decides which CLIENTS' data a user may see INSIDE that tenant. Every
 * client/workflow/execution/conversation/analytics path consults it.
 *
 *  - owner / admin → FULL data access (memberClientId === null, i.e. "all
 *    clients"). For RBAC-1 the two are equivalent for data; admin vs owner only
 *    diverges for owner-only actions in later steps. These are the AGENCY.
 *  - member         → exactly ONE client (memberClientId), and within it a CLIENT
 *    ROLE that says what they may do (see ClientRole): the people who work at that
 *    client (the barbershop). Never another client, never a tenant-level surface.
 *
 * CLIENT ROLES (only meaningful for role === "member"):
 *  - owner  → full control of THEIR client (inbox, contacts, agenda, analytics,
 *             settings, custom fields, and managing this client's Setters/Staff);
 *  - setter → works the chats + CRM: inbox, contacts, agenda + booking. NO analytics,
 *             executions, workflow internals, settings, custom fields or team. (This
 *             REPLACED the old generic "editor".)
 *  - staff  → their own agenda: sees the whole SITE but may create/modify only their
 *             OWN column; never contacts, inbox, analytics or settings.
 *
 * The scope is resolved from the SESSION at the data layer — the URL is never
 * trusted. Resolution FAILS CLOSED: an unknown role, a 'member' with no client, or a
 * member with an unknown/absent client role yields no access rather than silently
 * widening.
 */

export type Role = "owner" | "admin" | "member";

export interface AccessScope {
  tenantId: string;
  userId: string;
  role: Role;
  /** null = all clients (owner/admin); otherwise the single client a member sees. */
  memberClientId: string | null;
  /** The client-level role — non-null iff role === "member". */
  clientRole: ClientRole | null;
  /** Non-null iff clientRole === "staff" (the one staff resource + its site). */
  schedulingSiteId: string | null;
  schedulingStaffId: string | null;
}

/** owner/admin — full data access, no per-client restriction (the AGENCY). */
export function hasFullAccess(scope: AccessScope): boolean {
  return scope.memberClientId === null;
}

/**
 * The CLIENT OWNER of a specific client — full control of THAT client (settings,
 * custom fields, team) but nothing outside it, and never the agency tier.
 */
export function isClientOwner(scope: AccessScope, clientId: string): boolean {
  return scope.role === "member" && scope.clientRole === "owner" && scope.memberClientId === clientId;
}

/**
 * Deny-by-default client predicate: may this scope see this client's GENERAL data
 * (inbox, CRM, agenda — AND, for those allowed, workflows/analytics)? owner/admin: any
 * client of their tenant; a client OWNER or SETTER: only their one client. A STAFF login
 * is intentionally NARROWER — its one permitted surface is scheduling, admitted
 * explicitly by the scheduling module gate; treating it as a general client member here
 * would expose inbox/CRM by typing those URLs directly.
 *
 * NOTE: this admits the SETTER to the client (it needs inbox/contacts/agenda). Analytics,
 * executions and workflow internals are a SEPARATE capability — canSeeWorkflowInsights —
 * which the Setter does NOT have; those surfaces gate on it, not on canAccessClient.
 */
export function canAccessClient(scope: AccessScope, clientId: string): boolean {
  if (scope.clientRole === "staff") return false;
  return scope.memberClientId === null || scope.memberClientId === clientId;
}

/**
 * May this scope see WORKFLOW INSIGHTS — analytics, the executions list/detail, and
 * workflow internals (settings/config)? The agency and a client OWNER may; a SETTER may
 * NOT (its job is the chats, contacts and agenda, not the numbers), and neither may
 * STAFF. This is the capability the executions/analytics/settings surfaces gate on, so a
 * Setter still resolves a workflow for its INBOX but is refused everything else under it.
 */
export function canSeeWorkflowInsights(scope: AccessScope, clientId?: string): boolean {
  if (hasFullAccess(scope)) return true;
  if (scope.clientRole !== "owner") return false;
  return clientId === undefined || scope.memberClientId === clientId;
}

/**
 * May this scope MANAGE this client — its scheduling settings, custom field
 * definitions, and its team (Editors/Staff)? The agency (owner/admin) may manage any
 * of their clients; a Client Owner may manage only their own. Editors and Staff never.
 */
export function canManageClient(scope: AccessScope, clientId: string): boolean {
  return hasFullAccess(scope) || isClientOwner(scope, clientId);
}

/** A staff login — bound to one staff resource at one site; sees only scheduling. */
export function isSchedulingStaff(scope: AccessScope): boolean {
  return scope.clientRole === "staff";
}

/** Every client role (owner/setter/staff) — and the agency — may operate an agenda.
 *  A staff login is further restricted to its own column by canAccessSchedulingStaff. */
export function canOperateScheduling(scope: AccessScope): boolean {
  return hasFullAccess(scope) || scope.clientRole !== null;
}

/** Site predicate for scheduling pages and every scheduling Server Action. Owner/
 *  editor (and the agency) operate the whole client; a staff login is pinned to its
 *  one site. */
export function canAccessSchedulingSite(scope: AccessScope, siteId: string): boolean {
  if (scope.clientRole === "staff") return scope.schedulingSiteId === siteId;
  return true;
}

/** Staff WRITE predicate: a staff login may only create/modify appointments in its
 *  OWN column. Everyone else (owner/editor/agency) may act on any staff at a site they
 *  can access. This is the guard the appointment-write actions call. */
export function canAccessSchedulingStaff(scope: AccessScope, staffId: string): boolean {
  if (scope.clientRole === "staff") return scope.schedulingStaffId === staffId;
  return true;
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
  // Staff → their agenda. SETTER → the client attention queue (inbox): they can't see
  // analytics, so the old "all/analytics" landing would 404 for them. Owner → their
  // client's aggregate analytics. Agency → the Hub.
  if (scope.memberClientId) {
    if (scope.clientRole === "staff") return `/clients/${scope.memberClientId}/scheduling/agenda`;
    if (scope.clientRole === "setter") return `/clients/${scope.memberClientId}/inbox`;
    return `/clients/${scope.memberClientId}/workflows/all/analytics`; // owner
  }
  return "/";
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

  const clientRole = role === "member" ? membership.client_role : null;
  const schedulingSiteId = role === "member" ? membership.scheduling_site_id : null;
  const schedulingStaffId = role === "member" ? membership.scheduling_staff_id : null;

  // A member MUST carry a valid client role; a non-member MUST carry none. Unknown →
  // deny (never default to a wider role). The DB CHECK is the belt; this is the code side.
  if (role === "member") {
    if (clientRole !== "owner" && clientRole !== "setter" && clientRole !== "staff") return { ok: false };
  } else if (clientRole !== null) {
    return { ok: false };
  }
  // The site/staff binding exists iff the member is staff (mirrors the DB CHECK).
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
