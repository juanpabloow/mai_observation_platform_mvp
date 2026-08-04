import { authenticateScheduling, parseIsoDate, resolveLabelParams, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { resolveServiceParam, resolveStaffParam } from "@/lib/semanticParams";
import { localTimeFields } from "@/lib/localTime";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";

/**
 * GET /api/scheduling/v1/availability?site_id=&(service_id|service)=&(staff_id|staff)?=&from=&to=
 *
 * Real availability from the shared engine (identical rules to the public page).
 * The service may be given by `service_id` (UUID) OR `service` (NAME); staff optionally by
 * `staff_id` OR `staff` (NAME) — an LLM transcribes a name far more reliably than a UUID.
 * When staff is omitted, slots across all qualified staff are returned, each carrying the
 * deterministically chosen staff plus available_staff_ids. The window [from,to] is capped
 * to the site's booking horizon by the engine.
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
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (!siteId) return schedulingError(400, "invalid_request", "site_id is required.");
  if (!from || !to) return schedulingError(400, "invalid_request", "from and to must be ISO-8601 datetimes.");
  if (to.getTime() <= from.getTime()) return schedulingError(400, "invalid_request", "to must be after from.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    return schedulingError(400, "invalid_request", "Requested window is too large (max 45 days).");
  }
  // requireActive: availability is a NEW-booking read, so a deactivated site returns
  // site_inactive (409), not a misleading not_found — this was the operator's dead end.
  const owned = await resolveOwnedSite(auth.auth, siteId, { requireActive: true });
  if (!owned.ok) return owned.response;

  // service_id|service and staff_id|staff resolve BEFORE the engine — a bad name → 400 with
  // the valid names, an ambiguous name → ambiguous_match, a bad id → the specific 404.
  const svc = await resolveServiceParam(auth.auth, owned.site.id, p.get("service_id"), p.get("service"));
  if (!svc.ok) return svc.response;
  const stf = await resolveStaffParam(auth.auth, owned.site.id, p.get("staff_id"), p.get("staff"));
  if (!stf.ok) return stf.response;

  const result = await loadAvailability({
    tenantId: auth.auth.tenantId,
    siteId: owned.site.id,
    serviceId: svc.value,
    staffId: stf.value,
    from,
    to,
    now: new Date(),
  });
  if (!result) return schedulingError(404, "service_not_found", "That service isn’t offered at this site. Call GET /api/scheduling/v1/services?site_id=… to get valid service ids.");

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
