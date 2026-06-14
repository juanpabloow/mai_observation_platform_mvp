import { getServerSession } from "./session";
import { getTenantIdForUser } from "@worker/db/repositories/tenantMembers.js";

/**
 * Thrown when there is no authenticated session, or the authenticated user has
 * no tenant membership. Callers must treat this as "no data / not authorized".
 * The next step (route protection) catches this to redirect to /login; for now
 * it simply fails the request — which is the SAFE outcome (no data served).
 */
export class NoTenantError extends Error {
  constructor(message = "No tenant for the current session") {
    super(message);
    this.name = "NoTenantError";
  }
}

/**
 * Resolves the tenant for the current request from the LOGGED-IN user.
 *
 * This is the single chokepoint every tenant-scoped query routes through, so the
 * whole app becomes tenant-aware here. It reads the session SERVER-SIDE (data
 * layer, not middleware — CVE-2025-29927) and maps the user to their tenant via
 * tenant_members.
 *
 * It NEVER falls back to a default tenant: no session or no membership throws
 * NoTenantError, so the absence of a valid tenant yields NO data rather than
 * leaking another tenant's. (A user gets exactly one membership at signup, so
 * the no-membership case is effectively "not signed in".)
 */
export async function getCurrentTenantId(): Promise<string> {
  const session = await getServerSession();
  const userId = session?.user?.id;
  if (!userId) {
    throw new NoTenantError("No active session.");
  }

  const tenantId = await getTenantIdForUser(userId);
  if (!tenantId) {
    throw new NoTenantError("Authenticated user has no tenant membership.");
  }

  return tenantId;
}
