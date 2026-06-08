/**
 * Resolves the tenant for the current request.
 *
 * Auth does not exist yet, so this returns the default 'MAI' tenant. When real
 * auth arrives, change ONLY this function (read the tenant from the session /
 * request) — every execution query routes its tenant id through here, so no
 * call sites need to change. It is intentionally async to keep that signature
 * stable once it has to await a session.
 */
const DEFAULT_TENANT_ID = "11111111-1111-1111-1111-111111111111";

export async function getCurrentTenantId(): Promise<string> {
  return DEFAULT_TENANT_ID;
}
