import { checkRateLimit, clientIp } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { publicError, publicJson, publicNotFound, publicRateLimited } from "@/lib/publicBookingApi";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { firstOpenDay } from "@/lib/publicAvailability";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { listPublicStaffForService } from "@worker/db/repositories/scheduling/publicCatalog.js";
import { utcToZonedParts } from "@worker/scheduling/timezone.js";

/**
 * GET /api/booking/{slug}/next-available?service_id=&staff_id? — PUBLIC.
 *
 * The first day with a bookable time, within the site's booking horizon (capped at 62
 * days), for the chosen artist AND for each other public artist of the service, plus
 * "Sin preferencia". ONE run of the same engine as every other path (staff_id omitted, so
 * every qualified artist is computed independently — nothing is stitched together), so
 * "Ana tiene cupos desde el lunes" is always something the engine would book.
 *
 * It never chooses for the visitor: the page offers these as explicit actions. The
 * booking POST still revalidates the exact slot at commit.
 */
export const dynamic = "force-dynamic";

const MAX_DAYS = 62;
const DAY_MS = 86_400_000;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) return publicRateLimited(60);
  if (readPublicBookingPolicy().disabled) return publicNotFound();
  const { slug } = await params;
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return publicNotFound();

  const p = new URL(req.url).searchParams;
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  if (!serviceId || !isUuid(serviceId) || (staffId && !isUuid(staffId))) {
    return publicError(400, "invalid_request", "Elige un servicio y un profesional válidos.");
  }

  const now = new Date();
  const cfg = (site.scheduling_config ?? {}) as { booking_horizon_days?: number };
  const horizon = Math.min(MAX_DAYS, Number.isInteger(cfg.booking_horizon_days) && (cfg.booking_horizon_days as number) > 0 ? (cfg.booking_horizon_days as number) : 30);
  const [result, publicStaff] = await Promise.all([
    loadAvailability({ tenantId: site.tenant_id, siteId: site.id, serviceId, staffId: null, from: now, to: new Date(now.getTime() + (horizon + 1) * DAY_MS), now }),
    listPublicStaffForService(site.tenant_id, site.id, serviceId),
  ]);
  if (!result || publicStaff.length === 0) {
    return publicError(409, "service_unavailable", "Este servicio ya no está disponible en esta sede. Elige otro servicio.");
  }
  const publicIds = new Set(publicStaff.map((s) => s.id));
  const slots = result.slots
    .map((s) => ({ start_at: s.start_at.toISOString(), available_staff_ids: s.available_staff_ids.filter((id) => publicIds.has(id)) }))
    .filter((s) => s.available_staff_ids.length > 0);
  const tz = result.site.timezone;
  const dayOf = (iso: string) => {
    const z = utcToZonedParts(new Date(iso), tz);
    return `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
  };

  return publicJson({
    /** The chosen artist's first day (null = none within the horizon). */
    artist: staffId && publicIds.has(staffId) ? firstOpenDay(slots, dayOf, staffId) : null,
    /** "Sin preferencia": the first day anyone can take the whole service. */
    any: firstOpenDay(slots, dayOf, null),
    /** Every other public artist of the service, with their own first day. */
    others: publicStaff.filter((s) => s.id !== staffId).map((s) => ({ id: s.id, name: s.name, first_day: firstOpenDay(slots, dayOf, s.id) })),
    horizon_days: horizon,
  });
}
