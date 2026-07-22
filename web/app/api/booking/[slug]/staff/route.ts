import { checkRateLimit, clientIp, schedulingError } from "@/lib/schedulingApi";
import { getActiveSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { listStaffForService } from "@worker/db/repositories/scheduling/staff.js";

/**
 * GET /api/booking/{slug}/staff?service_id= — PUBLIC. Staff at the site who can
 * perform the given service (so the customer can pick a specific barber or "any").
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) {
    return schedulingError(429, "rate_limited", "Too many requests. Please slow down.");
  }
  const { slug } = await params;
  const serviceId = new URL(req.url).searchParams.get("service_id");
  if (!serviceId) return schedulingError(400, "invalid_request", "service_id is required.");
  const site = await getActiveSiteBySlug(slug);
  if (!site) return schedulingError(404, "not_found", "Booking page not found.");
  const staff = await listStaffForService(site.tenant_id, site.id, serviceId);
  return Response.json({ staff: staff.map((s) => ({ id: s.id, name: s.name })) });
}
