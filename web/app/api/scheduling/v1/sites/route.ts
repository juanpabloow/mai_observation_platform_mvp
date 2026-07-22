import { authenticateScheduling } from "@/lib/schedulingApi";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";

/**
 * GET /api/scheduling/v1/sites — active sites for the token's tenant.
 * MACHINE endpoint (Bearer token). Tenant is derived from the token, never input.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const sites = await listSites(auth.auth.tenantId);
  return Response.json({
    sites: sites.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name,
      address: s.address,
      timezone: s.timezone,
      scheduling_config: s.scheduling_config,
    })),
  });
}
