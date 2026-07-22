import { authenticateScheduling, parseIsoDate, schedulingError } from "@/lib/schedulingApi";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/scheduling/v1/availability?site_id=&service_id=&staff_id?=&from=&to=
 *
 * Real availability from the shared engine (identical rules to the public page).
 * staff_id optional — when omitted, slots across all qualified staff are returned,
 * each carrying the deterministically chosen staff plus available_staff_ids. The
 * window [from,to] is capped to the site's booking horizon by the engine.
 */
export const dynamic = "force-dynamic";

const MAX_WINDOW_MS = 45 * 24 * 60 * 60 * 1000; // hard cap on a single query span

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const siteId = p.get("site_id");
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (!siteId || !serviceId) return schedulingError(400, "invalid_request", "site_id and service_id are required.");
  if (!from || !to) return schedulingError(400, "invalid_request", "from and to must be ISO-8601 datetimes.");
  if (to.getTime() <= from.getTime()) return schedulingError(400, "invalid_request", "to must be after from.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return schedulingError(400, "invalid_request", "Requested window is too large (max 45 days).");
  }

  const result = await loadAvailability({
    tenantId: auth.auth.tenantId,
    siteId,
    serviceId,
    staffId: staffId ?? null,
    from,
    to,
    now: new Date(),
  });
  if (!result) return schedulingError(404, "not_found", "Service is not offered at this site.");

  return Response.json({
    site: { id: result.site.id, timezone: result.site.timezone },
    duration_min: result.timing.duration_min,
    slots: result.slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
    })),
  });
}
