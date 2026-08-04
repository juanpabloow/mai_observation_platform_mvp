import { authenticateScheduling, parseIsoDate, resolveLabelParams, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { localTimeFields } from "@/lib/localTime";
import { isUuid } from "@/lib/clientModuleValidation";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { isServiceEnabledAtSite } from "@worker/db/repositories/scheduling/services.js";
import { isActiveStaffOfSite } from "@worker/db/repositories/scheduling/staff.js";

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
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  // C-6 presentation params (validated before any work; invalid tz/locale → 400, never a
  // silent UTC fallback).
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
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
  const owned = await resolveOwnedSite(auth.auth, siteId);
  if (!owned.ok) return owned.response;

  // Validate resource shapes + membership BEFORE the engine (no 22P02, no
  // foreign/unknown/not-enabled leaking): service must be enabled at this site,
  // and a given staff_id must be an active staff OF this site.
  if (!isUuid(serviceId) || (staffId && !isUuid(staffId))) {
    return schedulingError(404, "not_found", "Not found.");
  }
  if (!(await isServiceEnabledAtSite(auth.auth.tenantId, owned.site.id, serviceId))) {
    return schedulingError(404, "not_found", "Not found.");
  }
  if (staffId && !(await isActiveStaffOfSite(auth.auth.tenantId, owned.site.id, staffId))) {
    return schedulingError(404, "not_found", "Not found.");
  }

  const result = await loadAvailability({
    tenantId: auth.auth.tenantId,
    siteId: owned.site.id,
    serviceId,
    staffId: staffId ?? null,
    from,
    to,
    now: new Date(),
  });
  if (!result) return schedulingError(404, "not_found", "Service is not offered at this site.");

  // Label timezone: the ?tz override, else the site's own timezone (the physical place).
  const tz = labels.tzOverride ?? result.site.timezone;
  return Response.json({
    // `timezone` is the site's own tz; `timezone_used` is what the *_label/*_local fields
    // were formatted in (differs only when ?tz was passed).
    site: { id: result.site.id, timezone: result.site.timezone, timezone_used: tz },
    // start_at/service_end_at stay UTC (pass start_at back verbatim to book); the *_local
    // and *_label fields are display-only. Duration can differ per staff, so the window is
    // carried per slot rather than a single value.
    slots: result.slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      ...localTimeFields(s.start_at, s.service_end_at, tz, labels.locale),
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
      candidates: s.candidates,
    })),
  });
}
