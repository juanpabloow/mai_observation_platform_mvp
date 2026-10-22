"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope, inClientScope } from "./access";
import { getServerSession } from "./session";
import { isUuid } from "./clientModuleValidation";
import { SYSTEM_ROLE_LABEL, SYSTEM_ROLE_PERMISSIONS, isSystemRoleKey, sanitizeBusinessPermissions, type PermissionKey } from "./permissions/catalog";
import { canCreateRole, canEditRole, canEditSystemRole, diffPermissions, validateRolePermissions } from "./permissions/delegation";
import { getClientById } from "@worker/db/repositories/clients.js";
import {
  createAccessRole,
  deleteAccessRole,
  resetSystemRoleOverride,
  saveSystemRoleOverride,
  updateAccessRole,
} from "@worker/db/repositories/accessRoles.js";

/**
 * ROLES of one business — create / edit / delete custom roles (whoever holds «Gestionar
 * roles»: the agency, the Dueño, or a custom role given it), and adjust or reset a SYSTEM role
 * for this business only (the AGENCY alone). Every call, before any write:
 *   1. session → membership → scope (getAccessScope; the URL/browser is never trusted);
 *   2. the client is inside the scope and is a real (non-default) client of the tenant;
 *   3. the permission list is valid: known keys, business-grantable, dependency-closed;
 *   4. the delegation rules (./permissions/delegation.ts): access.roles.manage on that
 *      business, nothing wider than the actor's own permissions (before AND after), and
 *      never the role the actor holds.
 * Edits are optimistic-concurrency (the editor's `version`); the delegation check runs
 * again on the LOCKED row inside the transaction, so a concurrent change can't slip
 * through. Every write commits together with its audit event. There is no authorization
 * cache: the next request of anyone holding the role already sees the change.
 */

export type RoleActionResult =
  | { ok: true; id: string; version: number }
  | { ok: false; error: string; stale?: true };

const NAME_MAX = 60;
const DESCRIPTION_MAX = 280;
const RESERVED = new Set(Object.values(SYSTEM_ROLE_LABEL).map((n) => n.toLocaleLowerCase("es")));

function validateText(name: unknown, description: unknown): { ok: true; name: string; description: string } | { ok: false; error: string } {
  const n = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  const d = typeof description === "string" ? description.trim() : "";
  if (!n) return { ok: false, error: "Escribe un nombre para el rol." };
  if (n.length > NAME_MAX) return { ok: false, error: `El nombre no puede pasar de ${NAME_MAX} caracteres.` };
  if (d.length > DESCRIPTION_MAX) return { ok: false, error: `La descripción no puede pasar de ${DESCRIPTION_MAX} caracteres.` };
  // A custom role can't impersonate a protected one by name.
  if (RESERVED.has(n.toLocaleLowerCase("es"))) return { ok: false, error: "Ese nombre es de un rol del sistema. Elige otro." };
  return { ok: true, name: n, description: d };
}

async function resolveBusiness(clientId: string) {
  if (!isUuid(clientId)) return null;
  const scope = await getAccessScope();
  if (!inClientScope(scope, clientId)) return null;
  const client = await getClientById({ tenantId: scope.tenantId, clientId });
  if (!client || client.is_default) return null;
  return { scope, client };
}

function revalidate(clientId: string) {
  revalidatePath(`/clients/${clientId}/team`);
}

const UNAVAILABLE = "No disponible.";
const DUPLICATE = "Ya hay un rol con ese nombre en este negocio.";
const STALE = "Otra persona cambió este rol mientras lo editabas. Recarga para ver la versión actual.";

export async function createRoleAction(input: {
  clientId: string;
  name: string;
  description?: string;
  permissions: string[];
}): Promise<RoleActionResult> {
  const biz = await resolveBusiness(input.clientId);
  if (!biz) return { ok: false, error: UNAVAILABLE };
  const { scope } = biz;
  const text = validateText(input.name, input.description ?? "");
  if (!text.ok) return text;
  const perms = validateRolePermissions(Array.isArray(input.permissions) ? input.permissions : []);
  if (!perms.ok) return perms;
  const allowed = canCreateRole(scope, input.clientId, perms.keys);
  if (!allowed.ok) return allowed;

  const r = await createAccessRole({
    tenantId: scope.tenantId,
    clientId: input.clientId,
    name: text.name,
    description: text.description,
    permissions: perms.keys,
    actorUserId: scope.userId,
    actorEmail: (await getServerSession())?.user?.email ?? null,
    auditChanges: { name: text.name, permissions: perms.keys },
  });
  if (!r.ok) return { ok: false, error: r.reason === "duplicate_name" ? DUPLICATE : UNAVAILABLE };
  revalidate(input.clientId);
  return { ok: true, id: r.id, version: r.version };
}

export async function updateRoleAction(input: {
  clientId: string;
  roleId: string;
  version: number;
  name: string;
  description?: string;
  permissions: string[];
}): Promise<RoleActionResult> {
  if (!isUuid(input.roleId) || !Number.isInteger(input.version)) return { ok: false, error: UNAVAILABLE };
  const biz = await resolveBusiness(input.clientId);
  if (!biz) return { ok: false, error: UNAVAILABLE };
  const { scope } = biz;
  const text = validateText(input.name, input.description ?? "");
  if (!text.ok) return text;
  const perms = validateRolePermissions(Array.isArray(input.permissions) ? input.permissions : []);
  if (!perms.ok) return perms;
  let denied: string | null = null;

  const r = await updateAccessRole({
    tenantId: scope.tenantId,
    clientId: input.clientId,
    roleId: input.roleId,
    expectedVersion: input.version,
    name: text.name,
    description: text.description,
    permissions: perms.keys,
    actorUserId: scope.userId,
    actorEmail: (await getServerSession())?.user?.email ?? null,
    authorize: (current) => {
      const before = sanitizeBusinessPermissions(current.permissions);
      const d = canEditRole(scope, input.clientId, input.roleId, before, perms.keys);
      if (d.ok) return { ok: true };
      denied = d.error;
      return { ok: false, reason: "forbidden" };
    },
    auditChanges: (current) => {
      const { added, removed } = diffPermissions(sanitizeBusinessPermissions(current.permissions), perms.keys as PermissionKey[]);
      return {
        added,
        removed,
        ...(current.name !== text.name ? { name: { from: current.name, to: text.name } } : {}),
        ...(current.description !== text.description ? { descriptionChanged: true } : {}),
      };
    },
  });
  if (!r.ok) {
    if (r.reason === "forbidden") return { ok: false, error: denied ?? UNAVAILABLE };
    if (r.reason === "stale") return { ok: false, error: STALE, stale: true };
    if (r.reason === "duplicate_name") return { ok: false, error: DUPLICATE };
    return { ok: false, error: UNAVAILABLE };
  }
  revalidate(input.clientId);
  return { ok: true, id: r.id, version: r.version };
}

export async function deleteRoleAction(input: { clientId: string; roleId: string }): Promise<RoleActionResult> {
  if (!isUuid(input.roleId)) return { ok: false, error: UNAVAILABLE };
  const biz = await resolveBusiness(input.clientId);
  if (!biz) return { ok: false, error: UNAVAILABLE };
  const { scope } = biz;
  let denied: string | null = null;
  const r = await deleteAccessRole({
    tenantId: scope.tenantId,
    clientId: input.clientId,
    roleId: input.roleId,
    actorUserId: scope.userId,
    actorEmail: (await getServerSession())?.user?.email ?? null,
    authorize: (current) => {
      const d = canEditRole(scope, input.clientId, input.roleId, sanitizeBusinessPermissions(current.permissions), []);
      if (d.ok) return { ok: true };
      denied = d.error;
      return { ok: false, reason: "forbidden" };
    },
  });
  if (!r.ok) {
    if (r.reason === "forbidden") return { ok: false, error: denied ?? UNAVAILABLE };
    if (r.reason === "in_use") {
      return { ok: false, error: "Este rol está asignado a usuarios o a invitaciones pendientes. Cámbiales el rol antes de eliminarlo." };
    }
    return { ok: false, error: UNAVAILABLE };
  }
  revalidate(input.clientId);
  return { ok: true, id: input.roleId, version: 0 };
}

/**
 * Adjust a SYSTEM role (Dueño / Recepción / Profesional) for THIS business only — every
 * member of the business with that role gets the new set on their next request; other
 * businesses keep the default. Agency only. `version` null = no adjustment existed when the
 * editor opened (optimistic concurrency, like custom roles).
 */
export async function updateSystemRoleAction(input: {
  clientId: string;
  systemKey: string;
  version: number | null;
  permissions: string[];
}): Promise<RoleActionResult> {
  if (!isSystemRoleKey(input.systemKey)) return { ok: false, error: UNAVAILABLE };
  if (input.version !== null && !Number.isInteger(input.version)) return { ok: false, error: UNAVAILABLE };
  const biz = await resolveBusiness(input.clientId);
  if (!biz) return { ok: false, error: UNAVAILABLE };
  const { scope } = biz;
  const perms = validateRolePermissions(Array.isArray(input.permissions) ? input.permissions : []);
  if (!perms.ok) return perms;
  const allowed = canEditSystemRole(scope, input.clientId, perms.keys);
  if (!allowed.ok) return allowed;
  const r = await saveSystemRoleOverride({
    tenantId: scope.tenantId,
    clientId: input.clientId,
    systemKey: input.systemKey,
    label: SYSTEM_ROLE_LABEL[input.systemKey],
    expectedVersion: input.version,
    permissions: perms.keys,
    defaultPermissions: [...SYSTEM_ROLE_PERMISSIONS[input.systemKey]],
    actorUserId: scope.userId,
    actorEmail: (await getServerSession())?.user?.email ?? null,
  });
  if (!r.ok) return { ok: false, error: STALE, stale: true };
  revalidate(input.clientId);
  return { ok: true, id: `system:${input.systemKey}`, version: r.version };
}

/** Put a SYSTEM role of this business back to its default permissions. Agency only. */
export async function resetSystemRoleAction(input: { clientId: string; systemKey: string }): Promise<RoleActionResult> {
  if (!isSystemRoleKey(input.systemKey)) return { ok: false, error: UNAVAILABLE };
  const biz = await resolveBusiness(input.clientId);
  if (!biz) return { ok: false, error: UNAVAILABLE };
  const { scope } = biz;
  const allowed = canEditSystemRole(scope, input.clientId, SYSTEM_ROLE_PERMISSIONS[input.systemKey]);
  if (!allowed.ok) return allowed;
  await resetSystemRoleOverride({
    tenantId: scope.tenantId,
    clientId: input.clientId,
    systemKey: input.systemKey,
    label: SYSTEM_ROLE_LABEL[input.systemKey],
    actorUserId: scope.userId,
    actorEmail: (await getServerSession())?.user?.email ?? null,
  });
  revalidate(input.clientId);
  return { ok: true, id: `system:${input.systemKey}`, version: 0 };
}
