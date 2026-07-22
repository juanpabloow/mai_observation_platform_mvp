import { getSessionScope, hasFullAccess } from "@/lib/access";
import { parseIsoDate } from "@/lib/schedulingApi";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/scheduling/internal/availability — SESSION-authed availability for the
 * agenda's "new appointment" form. Owner/admin only; tenant from the session
 * (never input). Same engine as the machine + public paths.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const scope = await getSessionScope();
  if (!scope || !hasFullAccess(scope)) return Response.json({ error: "forbidden" }, { status: 403 });

  const p = new URL(req.url).searchParams;
  const siteId = p.get("site_id");
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (!siteId || !serviceId || !from || !to) {
    return Response.json({ error: "site_id, service_id, from, to are required" }, { status: 400 });
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
