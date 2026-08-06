import { authenticateScheduling, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { priceLabelCOP } from "@/lib/money";
import { listServicesForSite } from "@worker/db/repositories/scheduling/services.js";

/**
 * GET /api/scheduling/v1/services?site_id=[&featured=true] — services enabled at a site
 * OWNED BY the resolved client. MACHINE endpoint; a foreign/unknown/invalid site_id → the
 * generic 404 (never lists another client's services).
 *
 * FEATURED (E-2): each service carries `featured`, and featured services are returned FIRST
 * so a caller reading the list in order naturally leads with them. `?featured=true` narrows
 * to only the featured ones — EXCEPT when the client has marked none, where it falls back to
 * the FULL list rather than an empty one, so an agent is never left with nothing to offer.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const url = new URL(req.url);
  const siteId = url.searchParams.get("site_id");
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  const featuredOnly = url.searchParams.get("featured") === "true";
  // requireActive: the service catalogue is for BOOKING at this site; a deactivated site
  // returns site_inactive (409), not a misleading site_not_found.
  const owned = await resolveOwnedSite(auth.auth, siteId, { requireActive: true });
  if (!owned.ok) return owned.response;
  const all = await listServicesForSite(auth.auth.tenantId, owned.site.id); // already featured-first
  const featured = all.filter((s) => s.featured);
  // Empty-fallback: featured=true with NONE configured → the full list, never an empty offer.
  const chosen = featuredOnly && featured.length > 0 ? featured : all;
  return Response.json({
    services: chosen.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      duration_min: s.effective_duration_min,
      price: s.effective_price,
      // E-4 additive: a canonical Colombian money label so an agent quotes it consistently.
      price_label: priceLabelCOP(s.effective_price),
      buffer_before_min: s.buffer_before_min,
      buffer_after_min: s.buffer_after_min,
      featured: s.featured,
    })),
  });
}
