import { checkRateLimit, clientIp } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { projectPublicStaff, publicError, publicJson, publicNotFound, publicRateLimited } from "@/lib/publicBookingApi";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { listPublicStaffForService } from "@worker/db/repositories/scheduling/publicCatalog.js";

/**
 * GET /api/booking/{slug}/staff?service_id= — PUBLIC. The professionals at the site who
 * can perform the service (so the customer can pick one, or "Cualquier profesional").
 * Only active staff who take bookings; only id, name and THEIR duration/price for the
 * service — never a phone, email, schedule or permission.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) return publicRateLimited(60);
  if (readPublicBookingPolicy().disabled) return publicNotFound();
  const { slug } = await params;
  // GATE FIRST: a disabled/unknown site 404s even without a service_id.
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return publicNotFound();
  const serviceId = new URL(req.url).searchParams.get("service_id");
  // Validate the id SHAPE before the query (R1): a malformed uuid is a 400, not a 500.
  if (!serviceId || !isUuid(serviceId)) {
    return publicError(400, "invalid_request", "Elige un servicio válido.");
  }
  const staff = await listPublicStaffForService(site.tenant_id, site.id, serviceId);
  return publicJson({ staff: staff.map(projectPublicStaff) });
}
