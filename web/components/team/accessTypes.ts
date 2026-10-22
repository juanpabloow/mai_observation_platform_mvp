/**
 * View models for «Usuarios y accesos» (Usuarios · Roles y permisos). Built on the SERVER
 * (app/clients/[clientId]/team/page.tsx) with the delegation rules already applied: every
 * `can*` flag and every option list is what the server actions would accept for this
 * viewer — the screen only shows them. The actions re-check everything on each call.
 */

/** A role someone may be given here: a system role or a custom role of this business. */
export interface RoleChoice {
  /** "sys:owner" | "sys:setter" | "sys:staff" | "custom:<uuid>" */
  value: string;
  label: string;
  hint: string;
  clientRole: "owner" | "setter" | "staff" | "custom";
  accessRoleId: string | null;
}

export interface RoleView {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  version: number;
  memberCount: number;
  pendingInviteCount: number;
  /** People who hold it (emails), for the "affected users" summary. */
  holders: string[];
  updatedLabel: string;
  updatedByEmail: string | null;
  /** The viewer may edit / delete it (access.roles.manage, subset rule, not its own role). */
  editable: boolean;
  /** Why not, when it isn't. */
  lockedWhy: string | null;
}

export interface SystemRoleView {
  key: "owner" | "setter" | "staff";
  label: string;
  help: string;
  /** Effective permissions in THIS business (the agency's adjustment, or the default). */
  permissions: string[];
  memberCount: number;
  /** The agency adjusted it for this business (else the default applies). */
  overridden: boolean;
  /** The adjustment's version (null = no adjustment yet) — optimistic concurrency. */
  version: number | null;
  /** The viewer may adjust it (the agency only). */
  editable: boolean;
  holders: string[];
  updatedLabel: string | null;
  updatedByEmail: string | null;
}

export interface AuditView {
  id: string;
  when: string;
  actor: string;
  text: string;
}

export interface AccessViewer {
  agency: boolean;
  /** Tenant owner (manages the admin tier). */
  isOwner: boolean;
  canManageMembers: boolean;
  canManageRoles: boolean;
  canAssignOwner: boolean;
  /** Keys this viewer may put into a role here (business-grantable ∩ its own). */
  grantable: string[];
  /** Roles this viewer may give (invitations and role changes). */
  assignable: RoleChoice[];
}

export const roleChoiceValue = (clientRole: string | null, accessRoleId: string | null): string =>
  clientRole === "custom" && accessRoleId ? `custom:${accessRoleId}` : `sys:${clientRole ?? ""}`;
