import { authenticateScheduling, schedulingError } from "@/lib/schedulingApi";
import { listStaff, listStaffForService } from "@worker/db/repositories/scheduling/staff.js";

/**
 * GET /api/scheduling/v1/staff?site_id=&service_id= — active staff at a site.
 * When service_id is given, only staff who can perform it. MACHINE endpoint.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const params = new URL(req.url).searchParams;
  const siteId = params.get("site_id");
  const serviceId = params.get("service_id");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");

  const rows = serviceId
    ? await listStaffForService(auth.auth.tenantId, siteId, serviceId)
    : await listStaff(auth.auth.tenantId, { siteId });

  return Response.json({
    staff: rows.map((s) => ({ id: s.id, name: s.name, site_id: s.site_id })),
  });
}
