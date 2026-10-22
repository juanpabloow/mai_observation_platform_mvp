import "server-only";
import { notFound } from "next/navigation";
import { NO_PERMISSION, canAny, getAccessScope, inClientScope, type AccessScope } from "./access";
import type { PermissionKey } from "./permissions/catalog";
import { isUuid } from "./clientModuleValidation";
import { getClientById, type ClientRow } from "@worker/db/repositories/clients.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import type { ClientModuleKey } from "@worker/modules/registry.js";

/**
 * THE access gate for module-scoped client surfaces (Phase 3A). Every
 * client-scoped page and action funnels through here instead of re-implementing
 * the checks. Fixed order — nothing module-related is queried before the gate
 * approves:
 *
 *   1. clientId must be a UUID (reuses the shared pure validator)
 *   2. session/membership resolve from the DATA layer (getAccessScope — the URL
 *      is never trusted; redirects to /login when logged out)
 *   3. the client is inside the login's SCOPE — owner/admin: any client of THEIR
 *      tenant; member: only memberClientId
 *   4. the client must exist IN THIS TENANT
 *   5. the default ("Unassigned") client can never have modules
 *   6. the module must be ENABLED for this client (no row / enabled=false deny)
 *   7. the login holds the PERMISSION the caller names (any of, when several) — every
 *      caller must name one: there is no "module access" without a capability.
 *
 *   effective access = module enabled ∧ permission ∧ scope.
 *
 * DENY-BY-DEFAULT and INDISTINGUISHABLE: malformed, foreign, missing, default,
 * and module-disabled all yield the same negative result — pages 404 via
 * requireClientModulePage, actions map it to one generic error — so probing the
 * URL/action never reveals which condition failed. Only step 7 is reported apart
 * (`forbidden: true`): it is reached solely inside the login's OWN business, so saying
 * "you no longer have permission" there reveals nothing it doesn't already know.
 */

export interface ClientModuleContext {
  scope: AccessScope;
  client: ClientRow;
}

export type ClientModuleResolution =
  | { ok: true; context: ClientModuleContext }
  | { ok: false; forbidden?: true };

/** One permission, or several of which any suffices. */
export type PermissionRequirement = PermissionKey | readonly PermissionKey[];

const asList = (p: PermissionRequirement): readonly PermissionKey[] => (typeof p === "string" ? [p] : p);

/**
 * Core gate for an ALREADY-RESOLVED scope (session-less callers like the
 * internal availability endpoint resolve their scope via getSessionScope and
 * reuse this — ONE gate, no divergent copies). A client_modules row for the
 * default client (e.g. backfill residue) is treated as untrusted and inert:
 * is_default is rejected BEFORE the module check ever runs.
 */
export async function resolveClientModuleForScope(
  scope: AccessScope,
  clientId: string,
  moduleKey: ClientModuleKey,
  permission: PermissionRequirement,
): Promise<ClientModuleResolution> {
  if (!isUuid(clientId)) return { ok: false };
  if (!inClientScope(scope, clientId)) return { ok: false };
  const client = await getClientById({ tenantId: scope.tenantId, clientId });
  if (!client) return { ok: false };
  if (client.is_default) return { ok: false }; // Unassigned can't have modules
  const enabled = await isClientModuleEnabled(scope.tenantId, clientId, moduleKey);
  if (!enabled) return { ok: false };
  if (!canAny(scope, asList(permission), clientId)) return { ok: false, forbidden: true };
  return { ok: true, context: { scope, client } };
}

/** Non-throwing resolver (for Server Actions — the caller maps to a generic
 * error). ORDER MATTERS: the UUID shape check runs FIRST, before any session/
 * membership resolution — a malformed clientId is rejected without touching
 * PostgreSQL. (resolveClientModuleForScope re-checks the UUID as defense in
 * depth for callers that resolve their own scope.) getAccessScope redirects
 * only when there is no session at all. */
export async function resolveClientModuleContext(
  clientId: string,
  moduleKey: ClientModuleKey,
  permission: PermissionRequirement,
): Promise<ClientModuleResolution> {
  if (!isUuid(clientId)) return { ok: false }; // before session/DB — cheap early reject
  const scope = await getAccessScope(); // session/membership; redirects if logged out
  return resolveClientModuleForScope(scope, clientId, moduleKey, permission);
}

/** Page variant: any failure → notFound() (a 404, indistinguishable across
 * causes). Returns the approved context otherwise. */
export async function requireClientModulePage(
  clientId: string,
  moduleKey: ClientModuleKey,
  permission: PermissionRequirement,
): Promise<ClientModuleContext> {
  const result = await resolveClientModuleContext(clientId, moduleKey, permission);
  if (!result.ok) notFound();
  return result.context;
}

/**
 * Server-Action convenience over resolveClientModuleContext: the approved context, or the
 * error string to return — the caller's generic one for every indistinguishable failure,
 * and NO_PERMISSION when the login is in its own business but lacks the permission (e.g.
 * it was revoked while the screen was open).
 */
export async function gateClientModule(
  clientId: string,
  moduleKey: ClientModuleKey,
  permission: PermissionRequirement,
  fallbackError: string,
): Promise<{ ok: true; context: ClientModuleContext } | { ok: false; error: string }> {
  const result = await resolveClientModuleContext(clientId, moduleKey, permission);
  if (result.ok) return result;
  return { ok: false, error: result.forbidden ? NO_PERMISSION : fallbackError };
}
