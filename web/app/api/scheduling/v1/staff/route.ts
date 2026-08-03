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
  const owned = await resolveOwnedSite(auth.auth, siteId);
  if (!owned.ok) return owned.response;

  let rows;
  if (serviceId) {
    // Validate the service_id shape (avoid a 22P02) and that it's actually
    // enabled at THIS site — a malformed/unknown/not-enabled service → generic 404.
    if (!isUuid(serviceId) || !(await isServiceEnabledAtSite(auth.auth.tenantId, owned.site.id, serviceId))) {
      return schedulingError(404, "not_found", "Not found.");
    }
    rows = await listStaffForService(auth.auth.tenantId, owned.site.id, serviceId);
  } else {
    rows = await listStaff(auth.auth.tenantId, { siteId: owned.site.id, clientId: auth.auth.clientId });
  }

  return Response.json({
    staff: rows.map((s) => ({ id: s.id, name: s.name, site_id: s.site_id })),
  });
}
