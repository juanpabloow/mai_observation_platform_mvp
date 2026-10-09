import { checkRateLimit, clientIp } from "@/lib/schedulingApi";
import { projectPublicService, projectPublicSite, publicJson, publicNotFound, publicRateLimited } from "@/lib/publicBookingApi";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { listPublicServicesForSite } from "@worker/db/repositories/scheduling/publicCatalog.js";

/**
 * GET /api/booking/{slug}/services — PUBLIC (no auth). Resolves the site by its
 * globally-unique slug through the public gate and lists the services a visitor can
 * book there. Rate-limited by IP. The payload is the minimal public projection
 * (publicCatalog.ts names every column): never a tenant/client id, buffer, flag or
 * another site's service.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) return publicRateLimited(60);
  if (readPublicBookingPolicy().disabled) return publicNotFound();
  const { slug } = await params;
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return publicNotFound();
  const services = await listPublicServicesForSite(site.tenant_id, site.id);
  return publicJson({
    site: projectPublicSite(site),
    services: services.map(projectPublicService),
  });
}
