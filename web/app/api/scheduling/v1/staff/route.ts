import { authenticateScheduling, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { listStaff, listStaffForService } from "@worker/db/repositories/scheduling/staff.js";
import { isServiceEnabledAtSite } from "@worker/db/repositories/scheduling/services.js";

/**
 * GET /api/scheduling/v1/staff?site_id=&service_id= — active staff at a site
 * OWNED BY the resolved client. When service_id is given, only staff who can
 * perform it. MACHINE endpoint; foreign/unknown site_id → generic 404.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const siteId = params.get("site_id");
  const serviceId = params.get("service_id");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  // requireActive: this lists bookable staff at a site; a deactivated site → site_inactive (409).
  const owned = await resolveOwnedSite(auth.auth, siteId, { requireActive: true });
  if (!owned.ok) return owned.response;

  let rows;
  if (serviceId) {
    // Malformed service_id → 400 (§3: fail loudly, never 404/empty). A well-formed but
    // unknown/not-enabled service → the specific, actionable service_not_found.
    if (!isUuid(serviceId)) {
      return schedulingError(400, "invalid_request", "service_id must be a valid UUID.");
    }
    if (!(await isServiceEnabledAtSite(auth.auth.tenantId, owned.site.id, serviceId))) {
      return schedulingError(404, "service_not_found", "No service with that id is offered at this site. Call GET /api/scheduling/v1/services?site_id=… to get valid service ids.");
    }
    rows = await listStaffForService(auth.auth.tenantId, owned.site.id, serviceId);
  } else {
    rows = await listStaff(auth.auth.tenantId, { siteId: owned.site.id, clientId: auth.auth.clientId });
  }

  return Response.json({
    staff: rows.map((s) => ({ id: s.id, name: s.name, site_id: s.site_id })),
  });
}
