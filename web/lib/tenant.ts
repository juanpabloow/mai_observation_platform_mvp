import { requireTenant } from "./requireAuth";

/**
 * Resolves the tenant for the current request from the LOGGED-IN user — the
 * single chokepoint every tenant-scoped query routes through.
 *
 * Delegates to requireTenant(), so it now also PROTECTS: with no session (or no
 * tenant membership) it redirects to /login instead of returning/throwing. Since
 * every data page + action funnels through here, the whole app is gated at the
 * data layer (not middleware — CVE-2025-29927). It never returns another
 * tenant's id and never a default.
 */
export async function getCurrentTenantId(): Promise<string> {
  const { tenantId } = await requireTenant();
  return tenantId;
}
