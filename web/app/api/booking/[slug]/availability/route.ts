import { checkRateLimit, clientIp, parseIsoDate, schedulingError } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/booking/{slug}/availability?service_id=&staff_id?=&from=&to= — PUBLIC.
 * The SAME engine and rules as the internal + n8n paths (single source of truth).
 */
export const dynamic = "force-dynamic";

const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) {
    return schedulingError(429, "rate_limited", "Too many requests. Please slow down.");
  }
  const { slug } = await params;
  // GATE FIRST: a disabled/unknown site 404s even with missing/invalid params.
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return schedulingError(404, "not_found", "Booking page not found.");

  const p = new URL(req.url).searchParams;
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  // Validate id + date SHAPES before any query (R1): a malformed uuid must never
  // reach a uuid column and 500 — it is a deliberate 400. staff_id is optional.
  if (!serviceId || !isUuid(serviceId) || (staffId && !isUuid(staffId))) {
    return schedulingError(400, "invalid_request", "service_id (and staff_id, if provided) must be a valid id.");
  }
  if (!from || !to) return schedulingError(400, "invalid_request", "from and to must be ISO-8601 datetimes.");
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return schedulingError(400, "invalid_request", "Invalid or too-large window (max 14 days).");
  }

  const result = await loadAvailability({
    tenantId: site.tenant_id,
    siteId: site.id,
    serviceId,
    staffId: staffId ?? null,
    from,
    to,
    now: new Date(),
  });
  if (!result) return schedulingError(404, "not_found", "Service not offered here.");
  return Response.json({
    timezone: result.site.timezone,
    slots: result.slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
    })),
  });
}
