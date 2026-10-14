import { authenticateScheduling, parseIsoDate, resolveLabelParams, resolveOwnedSite, schedulingError } from "@/lib/schedulingApi";
import { resolveServiceParam, resolveStaffParam } from "@/lib/semanticParams";
import { computeFreeBlocks, computeHasAvailability } from "@/lib/availabilityView";
import { localClock24, localDay, localTimeFields } from "@/lib/localTime";
import { prepareAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { computeAvailability } from "@worker/scheduling/availability.js";
import { buildExplanation } from "@/lib/availabilityExplainBuild";
import { EXPLANATION_VERSION } from "@/lib/availabilityExplanation";
import { listStaff, listStaffForService } from "@worker/db/repositories/scheduling/staff.js";
import { getServiceById } from "@worker/db/repositories/scheduling/services.js";
import { localDaysInWindow } from "@worker/scheduling/timezone.js";

/**
 * GET /api/scheduling/v1/availability?site_id=&(service_id|service)=&(staff_id|staff)?=&from=&to=[&compact=true]
 *
 * Real availability from the shared engine (identical rules to the public page).
 * The service may be given by `service_id` (UUID) OR `service` (NAME); staff optionally by
 * `staff_id` OR `staff` (NAME) — an LLM transcribes a name far more reliably than a UUID.
 * A `staff` filter returns ONLY that staff's slots (the engine does the set membership, not
 * the agent). Each slot additionally carries `staff_name` and `available_staff` [{id,name}].
 *
 * E-3 readability (reduce hallucination surface): the response also carries `free_blocks`
 * (contiguous free runs collapsed into ranges with read-aloud labels, per day + staff) and
 * `has_availability` ({day: bool} for each requested day). `?compact=true` trims each slot
 * to the fields a caller needs to choose + book (day, start_label, end_label, time,
 * staff_name); the full slot shape is the DEFAULT so existing callers are unaffected. A
 * conversational caller should use compact=true + free_blocks. When staff is omitted, slots
 * across all qualified staff are returned. The window [from,to] is capped by the engine.
 *
 * `?explain=true` (ADDITIVE, opt-in) adds an `explanation` block — WHY each requested
 * professional has or lacks slots per local day (site closed, off shift, a block with its
 * PUBLIC reason only, booked, the service does not fit, booking rules, or `multiple` /
 * `unknown`), the next real slot after the window and other professionals with slots. The
 * slots themselves are computed exactly as without it. See web/lib/availabilityExplanation.ts
 * and docs/scheduling-availability-explain.md. Without the flag the response is unchanged.
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
  const explainRaw = p.get("explain");
  if (explainRaw !== null && explainRaw !== "true" && explainRaw !== "false") {
    return schedulingError(400, "invalid_request", "explain must be true or false.");
  }
  const explain = explainRaw === "true";
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

  // Staff name map for the slot labels (ids in slots are always active staff of the site).
  const staffRows = await listStaff(auth.auth.tenantId, { siteId: owned.site.id, includeInactive: true });
  const nameById = new Map(staffRows.map((s) => [s.id, s.name] as const));

  // If a specific staff was requested, verify they actually PERFORM this service. A barber
  // who doesn't do the service is a real business case; returning it as an empty slot list
  // is indistinguishable from "no availability", so answer with a distinct, readable error.
  if (stf.value) {
    const qualified = await listStaffForService(auth.auth.tenantId, owned.site.id, svc.value);
    if (!qualified.some((q) => q.id === stf.value)) {
      const staffName = nameById.get(stf.value) ?? "That staff member";
      const service = await getServiceById(auth.auth.tenantId, auth.auth.clientId, svc.value);
      const who = qualified.map((q) => q.name).join(", ") || "no one at this site";
      const message = `${staffName} doesn’t perform ${service?.name ?? "that service"}. Staff who do: ${who}. Omit the staff filter to see all availability, or pick a service ${staffName} performs.`;
      if (!explain) return schedulingError(409, "staff_service_mismatch", message);
      // Same 409 and code; explain=true adds WHY — a professional who does not take bookings
      // is not the same as one who does not perform the service.
      const row = staffRows.find((s) => s.id === stf.value);
      const notBookable = row ? !row.takes_bookings : false;
      const name = nameById.get(stf.value) ?? "El profesional";
      return Response.json(
        {
          error: { code: "staff_service_mismatch", message },
          explanation: {
            version: EXPLANATION_VERSION,
            staff: [
              {
                staff_id: stf.value,
                staff_name: nameById.get(stf.value) ?? null,
                status: "unavailable",
                summary: notBookable ? "not_bookable" : "staff_does_not_perform_service",
                public_reason: null,
                public_reason_label: null,
                customer_message: notBookable
                  ? `${name} no tiene reservas disponibles por este medio.`
                  : `${name} no realiza ${service?.name ?? "ese servicio"}.`,
                days: [],
                next_available: null,
              },
            ],
            // NAMES ONLY — who performs the service, NOT who has time: slots_checked=false means
            // a caller must query /availability for that professional before offering any hour.
            alternatives: qualified.map((q) => ({ staff_id: q.id, staff_name: q.name, slots_checked: false })),
          },
        },
        { status: 409 },
      );
    }
  }

  const now = new Date();
  // prepare + compute IS loadAvailability (same reads, same engine); split here so the
  // explanation reads exactly what the slots were computed from.
  const prepared = await prepareAvailability({
    tenantId: auth.auth.tenantId,
    siteId: owned.site.id,
    serviceId: svc.value,
    staffId: stf.value,
    from,
    to,
    now,
  });
  const result = prepared ? { site: prepared.site, slots: prepared.request ? computeAvailability(prepared.request) : [] } : null;
  if (!result || !prepared) return schedulingError(404, "service_not_found", "That service isn’t offered at this site. Call GET /api/scheduling/v1/services?site_id=… to get valid service ids.");

  // Label timezone: the ?tz override, else the site's own timezone (the physical place).
  const tz = labels.tzOverride ?? result.site.timezone;
  const compact = new URL(req.url).searchParams.get("compact") === "true";

  // E-3 §2a: collapse free slots into read-aloud ranges (per day + staff), server-side.
  const freeBlocks = computeFreeBlocks(
    result.slots.map((s) => ({ start_at: s.start_at, service_end_at: s.service_end_at, staff_id: s.staff_id, staff_name: nameById.get(s.staff_id) ?? null })),
    tz,
    labels.locale,
    owned.site.scheduling_config.slot_interval_min * 60_000,
  );
  // E-3 §2c: yes/no per requested local day, so a caller answers "¿hay cupo mañana?" by index.
  // The window is END-EXCLUSIVE: `to` at a local midnight does not add the day starting there
  // (it used to: a one-day query answered {day: false, nextDay: false}).
  const requestedDays = localDaysInWindow(from, to, tz);
  const hasAvailability = computeHasAvailability(requestedDays, result.slots.map((s) => localDay(s.start_at, tz)));

  // E-3 §2b: compact trims each slot to what a conversational caller needs to choose + book.
  const slots = result.slots.map((s) =>
    compact
      ? {
          day: localDay(s.start_at, tz),
          start_label: localTimeFields(s.start_at, s.service_end_at, tz, labels.locale).start_label,
          end_label: localTimeFields(s.start_at, s.service_end_at, tz, labels.locale).end_label,
          time: localClock24(s.start_at, tz),
          staff_name: nameById.get(s.staff_id) ?? null,
        }
      : {
          start_at: s.start_at,
          service_end_at: s.service_end_at,
          ...localTimeFields(s.start_at, s.service_end_at, tz, labels.locale),
          staff_id: s.staff_id,
          // Additive (E-1 addendum): names so an agent can say "with Padre G" without mapping
          // ids. The id fields above are unchanged for programmatic callers.
          staff_name: nameById.get(s.staff_id) ?? null,
          available_staff_ids: s.available_staff_ids,
          available_staff: s.available_staff_ids.map((id) => ({ id, name: nameById.get(id) ?? null })),
          candidates: s.candidates,
        },
  );

  const explanation = explain
    ? await buildExplanation({
        tenantId: auth.auth.tenantId,
        siteId: owned.site.id,
        serviceId: svc.value,
        staffId: stf.value,
        from,
        to,
        now,
        prepared,
        slots: result.slots,
        nameById,
        tz,
        locale: labels.locale,
      })
    : undefined;

  return Response.json({
    // `timezone` is the site's own tz; `timezone_used` is what the *_label/*_local fields
    // were formatted in (differs only when ?tz was passed).
    site: { id: result.site.id, timezone: result.site.timezone, timezone_used: tz },
    has_availability: hasAvailability,
    free_blocks: freeBlocks,
    // start_at/service_end_at stay UTC (pass start_at back verbatim to book); the *_local
    // and *_label fields are display-only. Duration can differ per staff, so the window is
    // carried per slot rather than a single value.
    slots,
    ...(explanation ? { explanation } : {}),
  });
}
