import { authenticateScheduling, schedulingError } from "@/lib/schedulingApi";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";

/**
 * GET /api/scheduling/v1/services?site_id= — services enabled at a site, with the
 * site-effective duration/price. MACHINE endpoint (Bearer token), tenant-scoped.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const siteId = new URL(req.url).searchParams.get("site_id");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  const services = await listServicesForSite(auth.auth.tenantId, siteId);
  return Response.json({
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      duration_min: s.effective_duration_min,
      price: s.effective_price,
      buffer_before_min: s.buffer_before_min,
      buffer_after_min: s.buffer_after_min,
    })),
  });
}
