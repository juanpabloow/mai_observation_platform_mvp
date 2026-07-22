import { canAccessClient, getSessionScope } from "@/lib/access";
import { parseIsoDate } from "@/lib/schedulingApi";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/scheduling/internal/availability — SESSION-authed availability for the
 * agenda's "new appointment" form. Any tenant role; a member is restricted to
 * their own client's sites (the requested site must be in scope). Tenant from the
 * session (never input). Same engine as the machine + public paths.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const scope = await getSessionScope();
  if (!scope) return Response.json({ error: "forbidden" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const siteId = p.get("site_id");
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (!siteId || !serviceId || !from || !to) {
    return Response.json({ error: "site_id, service_id, from, to are required" }, { status: 400 });
  }
  // A member may only query their own client's sites.
  const site = await getSiteById(scope.tenantId, siteId);
  if (!site || !canAccessClient(scope, site.client_id)) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const result = await loadAvailability({
    tenantId: scope.tenantId,
    siteId,
    serviceId,
    staffId: staffId ?? null,
    from,
    to,
    now: new Date(),
  });
  if (!result) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    site: { id: result.site.id, timezone: result.site.timezone },
    slots: result.slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
    })),
  });
}
