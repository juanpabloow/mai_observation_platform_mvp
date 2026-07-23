import { checkRateLimit, clientIp, schedulingError } from "@/lib/schedulingApi";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";

/**
 * GET /api/booking/{slug}/services — PUBLIC (no auth). Resolves the site by its
 * globally-unique slug (active only) and lists its services. Rate-limited by IP;
 * never exposes another tenant's data (only this site's enabled services).
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) {
    return schedulingError(429, "rate_limited", "Too many requests. Please slow down.");
  }
  const { slug } = await params;
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return schedulingError(404, "not_found", "Booking page not found.");
  const services = await listServicesForSite(site.tenant_id, site.id);
  return Response.json({
    site: { name: site.name, timezone: site.timezone, address: site.address },
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      duration_min: s.effective_duration_min,
      price: s.effective_price,
    })),
  });
}
