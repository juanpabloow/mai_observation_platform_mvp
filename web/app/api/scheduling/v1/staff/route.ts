import { authenticateScheduling, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { resolveServiceParam } from "@/lib/semanticParams";
import { listStaff, listStaffForService } from "@worker/db/repositories/scheduling/staff.js";

/**
 * GET /api/scheduling/v1/staff?site_id=&(service_id|service)= — active staff at a site
 * OWNED BY the resolved client. When a service is given (by `service_id` UUID or `service`
 * NAME), only staff who can perform it. MACHINE endpoint; foreign/unknown site_id → 404.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const siteId = params.get("site_id");
  const serviceIdParam = params.get("service_id");
  const serviceName = params.get("service");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  // requireActive: this lists bookable staff at a site; a deactivated site → site_inactive (409).
  const owned = await resolveOwnedSite(auth.auth, siteId, { requireActive: true });
  if (!owned.ok) return owned.response;

  let rows;
  if (serviceIdParam || serviceName) {
    // service_id (UUID) or service (NAME) → the specific 400/404/ambiguous errors.
    const svc = await resolveServiceParam(auth.auth, owned.site.id, serviceIdParam, serviceName);
    if (!svc.ok) return svc.response;
    rows = await listStaffForService(auth.auth.tenantId, owned.site.id, svc.value);
  } else {
    rows = await listStaff(auth.auth.tenantId, { siteId: owned.site.id, clientId: auth.auth.clientId });
  }

  return Response.json({
    staff: rows.map((s) => ({ id: s.id, name: s.name, site_id: s.site_id })),
  });
}
