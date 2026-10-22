import { checkRateLimit, clientIp, parseIsoDate } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { projectPublicSlots, publicError, publicJson, publicNotFound, publicRateLimited } from "@/lib/publicBookingApi";
import { readPublicBookingPolicy } from "@/lib/publicBookingPolicy";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { loadExplainExceptions, prepareAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { computeAvailability } from "@worker/scheduling/availability.js";
import { explainAvailability } from "@worker/scheduling/availabilityExplain.js";
import { publicDaysForAny, publicDaysForArtist } from "@/lib/publicAvailability";
import { listPublicStaffForService } from "@worker/db/repositories/scheduling/publicCatalog.js";

/**
 * GET /api/booking/{slug}/availability?service_id=&staff_id?=&from=&to= — PUBLIC.
 * The SAME engine and rules as the internal + n8n paths (single source of truth). The
 * window is capped at 14 days; the booking page covers a month by asking for it in
 * consecutive ≤14-day segments. Slots are restricted to the professionals the public
 * staff list shows, so "Cualquier profesional" never resolves to someone hidden.
 *
 * `explain=1` (opt-in; the default response is unchanged) adds `days`: per local day,
 * whether it is open, the SITE is closed, THIS artist is not working, or no time is left
 * for the service — from the availability explainer, which reads the engine's own
 * inputs (web/lib/publicAvailability.ts). Only a block's published reason is carried.
 */
export const dynamic = "force-dynamic";

const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-read:${clientIp(req)}`, 120, 60_000)) return publicRateLimited(60);
  if (readPublicBookingPolicy().disabled) return publicNotFound();
  const { slug } = await params;
  // GATE FIRST: a disabled/unknown site 404s even with missing/invalid params.
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return publicNotFound();

  const p = new URL(req.url).searchParams;
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  // Validate id + date SHAPES before any query (R1): a malformed uuid must never
  // reach a uuid column and 500 — it is a deliberate 400. staff_id is optional.
  if (!serviceId || !isUuid(serviceId) || (staffId && !isUuid(staffId))) {
    return publicError(400, "invalid_request", "Elige un servicio y un profesional válidos.");
  }
  if (!from || !to) return publicError(400, "invalid_request", "Las fechas no son válidas.");
  if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return publicError(400, "invalid_request", "El rango de fechas no es válido (máximo 14 días).");
  }

  const explain = p.get("explain") === "1";
  const now = new Date();
  const [prepared, publicStaff] = await Promise.all([
    prepareAvailability({
      tenantId: site.tenant_id,
      siteId: site.id,
      serviceId,
      staffId: staffId ?? null,
      from,
      to,
      now,
    }),
    listPublicStaffForService(site.tenant_id, site.id, serviceId),
  ]);
  const result = prepared ? { site: prepared.site, slots: prepared.request ? computeAvailability(prepared.request) : [] } : null;
  // No public professional = the service is not on the page any more (hidden, moved to a
  // WhatsApp-only group, or nobody performs it): the same answer as an unbookable one.
  if (!result || publicStaff.length === 0) {
    return publicError(409, "service_unavailable", "Este servicio ya no está disponible en esta sede. Elige otro servicio.");
  }
  const publicIds = new Set(publicStaff.map((s) => s.id));
  const slots = projectPublicSlots(result.slots, publicIds);
  if (!explain || !prepared?.request) return publicJson({ timezone: result.site.timezone, slots });

  // Explain only the PUBLIC professionals (a hidden one never shapes what the page says).
  const staffIds = prepared.request.staff.map((s) => s.id).filter((id) => publicIds.has(id));
  const exceptions = await loadExplainExceptions({ tenantId: site.tenant_id, siteId: site.id, from, to, staffIds });
  const explanations = explainAvailability({
    request: prepared.request,
    // Only slots a public professional can take count as "open".
    slots: result.slots.filter((x) => x.available_staff_ids.some((id) => publicIds.has(id))),
    staffIds,
    siteExceptions: exceptions.site,
    staffExceptions: exceptions.staff,
    siteBreaks: exceptions.siteBreaks,
    staffBreaks: exceptions.staffBreaks,
  });
  const days = staffId && staffIds.includes(staffId) ? publicDaysForArtist(explanations, staffId) : publicDaysForAny(explanations, staffIds);
  return publicJson({ timezone: result.site.timezone, slots, days });
}
