import { authenticateScheduling, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";

/**
 * GET /api/scheduling/v1/services?site_id= — services enabled at a site OWNED BY
 * the resolved client. MACHINE endpoint; a foreign/unknown/invalid site_id → the
 * generic 404 (never lists another client's services).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const siteId = new URL(req.url).searchParams.get("site_id");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  const owned = await resolveOwnedSite(auth.auth, siteId);
  if (!owned.ok) return owned.response;
  const services = await listServicesForSite(auth.auth.tenantId, owned.site.id);
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
