/**
 * DELEGATION RULES — who may create/edit/delete a role, and who may give a role to whom.
 * PURE (no DB, no next/*): the role, member and invitation actions call these after
 * loading the real rows, and the role editor calls the same functions to decide which
 * controls to show — so the UI never offers what the server would refuse.
 *
 *  1. The actor must hold access.roles.manage (roles) / access.users.manage (people) ON
 *     THAT BUSINESS. The agency holds both on every business of its tenant. Adjusting a
 *     SYSTEM role (Dueño / Recepción / Profesional) for one business is the AGENCY's alone.
 *  2. SUBSET: nobody creates, edits, deletes or assigns a set of permissions wider than
 *     their own — before AND after the change. The agency's own set excludes what only
 *     the business may do (confirming value assumptions), so it can't hand that out either.
 *  3. NO SELF-SERVICE: a member never changes their own role, edits the role they hold,
 *     or removes themselves. (The agency is not a business member, so it never applies.)
 *  4. THE DUEÑO TIER IS THE AGENCY'S: only the agency assigns the Dueño role, and only the
 *     agency changes or removes someone who holds it. The last Dueño is protected by the
 *     caller (it needs a count).
 *  5. A business role only ever holds business-grantable keys (never agency-only ones),
 *     and a stored role is dependency-closed (editing needs seeing).
 */

import {
  BUSINESS_GRANTABLE_KEYS,
  SYSTEM_ROLE_PERMISSIONS,
  isPermissionKey,
  isSubset,
  missingRequirements,
  permissionDef,
  sanitizeBusinessPermissions,
  isSystemRoleKey,
  type PermissionKey,
  type SystemRoleKey,
} from "./catalog";

/** The slice of an AccessScope these rules read (kept structural so tests need no DB). */
export interface DelegationActor {
  userId: string;
  /** null = agency (tenant owner/admin) — acts on every business of its tenant. */
  memberClientId: string | null;
  clientRole: string | null;
  accessRoleId: string | null;
  permissions: ReadonlySet<PermissionKey>;
}

/** A role as the rules see it: one of the protected system roles, or a custom role. */
export type RoleRef =
  /** `permissions` = this business's override (absent → the code default). */
  | { kind: "system"; key: SystemRoleKey; permissions?: ReadonlySet<PermissionKey> }
  | { kind: "custom"; id: string; permissions: ReadonlySet<PermissionKey> };

export type Decision = { ok: true } | { ok: false; error: string };

const OK: Decision = { ok: true };
const deny = (error: string): Decision => ({ ok: false, error });

export const DENY = {
  noRoleAdmin: "No tienes permiso para gestionar roles en este negocio.",
  systemAgencyOnly: "Solo la agencia puede ajustar los roles protegidos.",
  noUserAdmin: "No tienes permiso para gestionar usuarios en este negocio.",
  wider: "No puedes conceder permisos que tú no tienes.",
  outside: "Este rol tiene permisos que tú no tienes, así que no puedes modificarlo.",
  ownRole: "No puedes modificar el rol que tienes asignado.",
  self: "No puedes cambiar tu propio acceso.",
  ownerTier: "Solo la agencia puede asignar, cambiar o quitar el rol Dueño.",
  agencyOnly: "Ese permiso solo lo tiene la agencia.",
} as const;

export function isAgencyActor(actor: DelegationActor): boolean {
  return actor.memberClientId === null;
}

function inBusiness(actor: DelegationActor, clientId: string): boolean {
  return actor.memberClientId === null || actor.memberClientId === clientId;
}

/** The role a stored membership/invitation row holds, or null when it doesn't resolve. */
export function roleRefOf(row: {
  client_role: string | null;
  access_role_id?: string | null;
  role_permissions?: readonly string[] | null;
  /** A system role adjusted for this business (null/absent = default). */
  system_override?: readonly string[] | null;
}): RoleRef | null {
  if (isSystemRoleKey(row.client_role)) {
    return Array.isArray(row.system_override)
      ? { kind: "system", key: row.client_role, permissions: sanitizeBusinessPermissions(row.system_override) }
      : { kind: "system", key: row.client_role };
  }
  if (row.client_role === "custom" && row.access_role_id) {
    return { kind: "custom", id: row.access_role_id, permissions: sanitizeBusinessPermissions(row.role_permissions ?? []) };
  }
  return null;
}

export function permissionsOfRole(role: RoleRef): ReadonlySet<PermissionKey> {
  return role.kind === "system" ? (role.permissions ?? SYSTEM_ROLE_PERMISSIONS[role.key]) : role.permissions;
}

/** Keys the actor may put into a business role on this client (rule 2 + rule 5). */
export function grantableBy(actor: DelegationActor, clientId: string): Set<PermissionKey> {
  if (!inBusiness(actor, clientId)) return new Set();
  return new Set(BUSINESS_GRANTABLE_KEYS.filter((k) => actor.permissions.has(k)));
}

/** Validate a permission list for a role: known, business-grantable, dependency-closed. */
export function validateRolePermissions(raw: readonly unknown[]): { ok: true; keys: PermissionKey[] } | { ok: false; error: string } {
  const grantable = new Set<string>(BUSINESS_GRANTABLE_KEYS);
  const keys = new Set<PermissionKey>();
  for (const k of raw) {
    if (!isPermissionKey(k)) return { ok: false, error: "Hay un permiso desconocido en la selección." };
    if (!grantable.has(k)) return { ok: false, error: DENY.agencyOnly };
    keys.add(k);
  }
  const missing = missingRequirements(keys);
  if (missing.length) {
    const m = missing[0];
    return {
      ok: false,
      error: `«${permissionDef(m.key).label}» necesita también «${permissionDef(m.missing[0]).label}».`,
    };
  }
  return { ok: true, keys: [...keys].sort() };
}

/** May the actor create a role with `after` on this business? */
export function canCreateRole(actor: DelegationActor, clientId: string, after: Iterable<PermissionKey>): Decision {
  if (!inBusiness(actor, clientId) || !actor.permissions.has("access.roles.manage")) return deny(DENY.noRoleAdmin);
  if (!isSubset(after, grantableBy(actor, clientId))) return deny(DENY.wider);
  return OK;
}

/** May the actor change a custom role from `before` to `after` (or delete it: after = [])? */
export function canEditRole(
  actor: DelegationActor,
  clientId: string,
  roleId: string,
  before: Iterable<PermissionKey>,
  after: Iterable<PermissionKey>,
): Decision {
  if (!inBusiness(actor, clientId) || !actor.permissions.has("access.roles.manage")) return deny(DENY.noRoleAdmin);
  if (!isAgencyActor(actor) && actor.accessRoleId === roleId) return deny(DENY.ownRole);
  const grantable = grantableBy(actor, clientId);
  if (!isSubset(before, grantable)) return deny(DENY.outside);
  if (!isSubset(after, grantable)) return deny(DENY.wider);
  return OK;
}

/** May the actor adjust a SYSTEM role for this business? The AGENCY only (decision
 *  2026-10-22) — a Dueño edits its custom roles but never changes what everyone in
 *  «Recepción» can do; never with keys a business role can't hold. */
export function canEditSystemRole(actor: DelegationActor, clientId: string, after: Iterable<PermissionKey>): Decision {
  if (!isAgencyActor(actor)) return deny(DENY.systemAgencyOnly);
  if (!inBusiness(actor, clientId) || !actor.permissions.has("access.roles.manage")) return deny(DENY.noRoleAdmin);
  if (!isSubset(after, grantableBy(actor, clientId))) return deny(DENY.wider);
  return OK;
}

/** May the actor GIVE this role to someone (an invitation, or as a new role)? */
export function canGrantRole(actor: DelegationActor, clientId: string, role: RoleRef): Decision {
  if (!inBusiness(actor, clientId) || !actor.permissions.has("access.users.manage")) return deny(DENY.noUserAdmin);
  if (role.kind === "system" && role.key === "owner") return isAgencyActor(actor) ? OK : deny(DENY.ownerTier);
  if (!isSubset(permissionsOfRole(role), grantableBy(actor, clientId))) return deny(DENY.wider);
  return OK;
}

/** May the actor act on (change the role of, or remove) a member that holds `current`? */
export function canManageMember(
  actor: DelegationActor,
  clientId: string,
  target: { userId: string; role: RoleRef },
): Decision {
  if (!inBusiness(actor, clientId) || !actor.permissions.has("access.users.manage")) return deny(DENY.noUserAdmin);
  if (!isAgencyActor(actor) && target.userId === actor.userId) return deny(DENY.self);
  if (target.role.kind === "system" && target.role.key === "owner") return isAgencyActor(actor) ? OK : deny(DENY.ownerTier);
  if (!isSubset(permissionsOfRole(target.role), grantableBy(actor, clientId))) return deny(DENY.outside);
  return OK;
}

/** Added / removed keys between two sets — the audit diff and the confirmation summary. */
export function diffPermissions(before: Iterable<PermissionKey>, after: Iterable<PermissionKey>): { added: PermissionKey[]; removed: PermissionKey[] } {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: [...a].filter((k) => !b.has(k)).sort(),
    removed: [...b].filter((k) => !a.has(k)).sort(),
  };
}
