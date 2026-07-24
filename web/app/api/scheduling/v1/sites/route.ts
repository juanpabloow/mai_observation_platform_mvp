import { authenticateScheduling } from "@/lib/schedulingApi";
import { listSites } from "@worker/db/repositories/scheduling/sites.js";

/**
 * GET /api/scheduling/v1/sites — active sites for the RESOLVED client only.
 * MACHINE endpoint (Bearer token + X-Workflow-Ref). Tenant AND client are derived
 * from the token+workflow, never input — a token never lists another client's sites.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const sites = await listSites(auth.auth.tenantId, { clientId: auth.auth.clientId });
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
