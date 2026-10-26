import { canAccessSchedulingSite, canAccessSchedulingStaff, getSessionScope } from "@/lib/access";
import { resolveClientModuleForScope } from "@/lib/clientModuleAccess";
import { isUuid } from "@/lib/clientModuleValidation";
import { parseIsoDate } from "@/lib/schedulingApi";
import { siteDayKey, todayAtSite } from "@/lib/siteCalendar";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { loadExplainExceptions, prepareAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { computeAvailability } from "@worker/scheduling/availability.js";
import { explainAvailability } from "@worker/scheduling/availabilityExplain.js";
import { immediateWindowMin } from "@worker/scheduling/immediate.js";
import { getAppointmentById, listStaffAppointmentsOverlapping } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * GET /api/scheduling/internal/availability — SESSION-authed availability for
 * the client-scoped agenda's forms. Uses the SAME central gate as the pages and
 * actions (resolveClientModuleForScope): UUID → canAccessClient → client in
 * tenant → NOT the default client (a backfilled client_modules row for
 * Unassigned is inert) → `scheduling` enabled. Then site exists in the tenant
 * AND site.client_id === client.id; service/staff validity is enforced by the
 * loader's joins. Availability is never computed before the whole gate passes.
 *
 * EVERY gate failure is the same generic 404 — foreign, disabled, default, and
 * unknown are indistinguishable, and nothing leaks about other clients. Past the gate, a
 * service the site does not offer answers 200 with no slots and
 * `unavailable: "service_not_offered"` (see below), so the forms can say why.
 *
 * `appointment_id` (reschedule): availability FOR MOVING THAT APPOINTMENT. It must be an
 * appointment of this client, at this site, that this login may modify (the same staff
 * predicate as gateAppointment) and still live. Then — exactly like the server check in
 * rescheduleAppointment — its own block is excluded from the busy set and its STORED
 * duration/buffers are used, and the service is the appointment's own. Every other
 * booking, break, time off and block still counts.
 *
 * `hold` (repeatable, at most 120): `<staff_id|site>~<from ISO>~<until ISO>` — time a form
 * is about to block but has NOT saved yet (the break or block being edited while one of its
 * affected appointments is rescheduled). Holds only REMOVE slots — they can never offer a
 * time the engine did not — so a crafted hold cannot widen availability.
 *
 * `immediate=1` («Atención sin cita · ahora»): the starts from NOW within the immediate
 * window, without the site's minimum notice — the one exception of src/scheduling/immediate.ts,
 * for a login that may book (agenda.book, gated above). Every other rule still applies; the
 * booking action re-checks the start on the server. Never offered for a reschedule.
 *
 * `past=1` («Atención sin cita · Esta atención ya se realizó»): the starts of TODAY at the site
 * (from `from`, today's local midnight) whose service has already ENDED, evaluated as of the
 * start of the day — every rule but «already started» (no minimum notice). Only today; never
 * with `immediate` or a reschedule. Read-only: the booking action re-checks the chosen start
 * (and refuses an overlap with the professional's completed appointments too).
 */
export const dynamic = "force-dynamic";

const notFoundResponse = (): Response => Response.json({ error: "not_found" }, { status: 404 });

export async function GET(req: Request): Promise<Response> {
  const scope = await getSessionScope();
  if (!scope) return notFoundResponse();

  const p = new URL(req.url).searchParams;
  const clientId = p.get("client_id");
  const siteId = p.get("site_id");
  const serviceId = p.get("service_id");
  const staffId = p.get("staff_id");
  const appointmentId = p.get("appointment_id");
  const from = parseIsoDate(p.get("from"));
  const to = parseIsoDate(p.get("to"));
  if (!clientId || !siteId || !serviceId || !from || !to) {
    return Response.json({ error: "client_id, site_id, service_id, from, to are required" }, { status: 400 });
  }
  if (!isUuid(siteId) || !isUuid(serviceId) || (staffId && !isUuid(staffId)) || (appointmentId && !isUuid(appointmentId))) {
    return notFoundResponse();
  }

  // The SAME central gate as pages/actions (incl. is_default rejection).
  // Availability feeds the booking/reschedule modals → agenda.book.
  const gate = await resolveClientModuleForScope(scope, clientId, "scheduling", "agenda.book");
  if (!gate.ok) return notFoundResponse();
  if (!canAccessSchedulingSite(scope, siteId)) {
    return notFoundResponse();
  }
  const site = await getSiteById(scope.tenantId, siteId);
  if (!site || site.client_id !== gate.context.client.id) return notFoundResponse();

  let moving: { id: string; serviceId: string; timing: { durationMin: number; bufferBeforeMin: number; bufferAfterMin: number } } | null = null;
  if (appointmentId) {
    const appt = await getAppointmentById(scope.tenantId, appointmentId);
    if (
      !appt ||
      appt.client_id !== gate.context.client.id ||
      appt.site_id !== site.id ||
      !canAccessSchedulingStaff(scope, appt.staff_id) ||
      !["scheduled", "confirmed"].includes(appt.status)
    ) {
      return notFoundResponse();
    }
    moving = {
      id: appt.id,
      serviceId: appt.service_id,
      timing: { durationMin: appt.duration_min_snapshot, bufferBeforeMin: appt.buffer_before_min_snapshot, bufferAfterMin: appt.buffer_after_min_snapshot },
    };
  }

  const immediate = p.get("immediate") === "1" && !moving;
  const past = p.get("past") === "1" && !moving && !immediate;
  const now = new Date();
  // «Ya se realizó»: today only — `from` must be inside today's site day and before now.
  if (past && (siteDayKey(from, site.timezone) !== todayAtSite(site.timezone, now) || from.getTime() >= now.getTime())) {
    return Response.json({ site: { id: site.id, timezone: site.timezone }, slots: [] });
  }
  const prepared = await prepareAvailability({
    tenantId: scope.tenantId,
    siteId,
    serviceId: moving?.serviceId ?? serviceId,
    staffId: staffId ?? null,
    from,
    to: past ? now : to,
    // As of the start of the day: every start today is judged by the rules, not by the clock.
    now: past ? from : now,
    excludeAppointmentId: moving?.id ?? null,
    timingOverride: moving?.timing ?? null,
    ignoreMinNotice: immediate || past,
  });
  // The gate has passed (this login may book at this site of this client). A service the
  // site does not offer — removed or deactivated after the appointment was booked, or simply
  // unknown — is not a failure to retry: say so, with no slots. Unknown, foreign and inactive
  // service ids all get this same answer, and the gate never depends on the service, so it
  // reveals nothing about other clients' catalogues.
  if (!prepared) {
    return Response.json({ site: { id: site.id, timezone: site.timezone }, slots: [], unavailable: "service_not_offered" });
  }
  const windowEnd = now.getTime() + immediateWindowMin(prepared.slotIntervalMin) * 60_000;
  const computed = prepared.request ? computeAvailability(prepared.request) : [];
  const result = {
    site: prepared.site,
    buffers: prepared.buffers,
    slots: immediate
      ? computed.filter((s) => s.start_at.getTime() >= now.getTime() - 60_000 && s.start_at.getTime() <= windowEnd)
      : past
        ? computed.filter((s) => s.service_end_at.getTime() <= now.getTime())
        : computed,
  };
  // «Ya se realizó»: the engine's busy set holds only ACTIVE appointments, so a start that
  // overlaps what a professional already COMPLETED (or a no-show) today is dropped here too —
  // the booking action refuses it anyway; this keeps it from being offered.
  if (past) {
    const staffIds = [...new Set(result.slots.flatMap((s) => s.candidates.map((c) => c.staff_id)))];
    const taken = new Map<string, Array<[number, number]>>();
    for (const id of staffIds) {
      const rows = await listStaffAppointmentsOverlapping(scope.tenantId, siteId, id, from, now);
      taken.set(id, rows.map((r) => [r.start_at.getTime(), r.service_end_at.getTime()]));
    }
    const bb = result.buffers.before_min * 60_000;
    const ba = result.buffers.after_min * 60_000;
    result.slots = result.slots.flatMap((s) => {
      const ok = s.candidates.filter((c) => !(taken.get(c.staff_id) ?? []).some(([a, b]) => a < c.service_end_at.getTime() + ba && b > s.start_at.getTime() - bb));
      if (ok.length === 0) return [];
      const chosen = ok.find((c) => c.staff_id === s.staff_id) ?? ok[0];
      return [{ ...s, staff_id: chosen.staff_id, service_end_at: chosen.service_end_at, available_staff_ids: ok.map((c) => c.staff_id), candidates: ok }];
    });
  }
  const holds = parseHolds(p.getAll("hold"));
  if (holds === null) return Response.json({ error: "invalid hold" }, { status: 400 });
  const bufBefore = result.buffers.before_min * 60_000;
  const bufAfter = result.buffers.after_min * 60_000;
  const slots = holds.length === 0
    ? result.slots
    : result.slots.flatMap((s) => {
        const ok = s.candidates.filter((c) => {
          const a = s.start_at.getTime() - bufBefore;
          const b = c.service_end_at.getTime() + bufAfter;
          return !holds.some((h) => (h.staffId === null || h.staffId === c.staff_id) && h.until > a && h.from < b);
        });
        if (ok.length === 0) return [];
        const chosen = ok.find((c) => c.staff_id === s.staff_id) ?? ok[0];
        return [{ ...s, staff_id: chosen.staff_id, service_end_at: chosen.service_end_at, available_staff_ids: ok.map((c) => c.staff_id), candidates: ok }];
      });
  // `explain=1` with one professional: WHY a day has no free time, in the engine's own codes
  // (closed site, off shift, absence, closure, fully booked…) — the reschedule panel says the
  // reason instead of an empty list. Public reasons only; internal notes never leave.
  let days: Array<{ date: string; summary: string }> | undefined;
  if (p.get("explain") === "1" && staffId && prepared.request) {
    const exc = await loadExplainExceptions({ tenantId: scope.tenantId, siteId, from, to, staffIds: [staffId] });
    days = explainAvailability({
      request: prepared.request,
      slots: result.slots,
      staffIds: [staffId],
      siteExceptions: exc.site,
      staffExceptions: exc.staff,
      siteBreaks: exc.siteBreaks,
      staffBreaks: exc.staffBreaks,
    }).map((d) => ({ date: d.date, summary: d.summary }));
  }
  return Response.json({
    ...(days ? { days } : {}),
    site: { id: result.site.id, timezone: result.site.timezone },
    slots: slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
    })),
  });
}

function parseHolds(raw: string[]): Array<{ staffId: string | null; from: number; until: number }> | null {
  if (raw.length > 120) return null;
  const out: Array<{ staffId: string | null; from: number; until: number }> = [];
  for (const h of raw) {
    const [who, a, b] = h.split("~");
    const from = Date.parse(a ?? "");
    const until = Date.parse(b ?? "");
    if ((who !== "site" && !isUuid(who)) || Number.isNaN(from) || Number.isNaN(until) || until <= from || until - from > 86_400_000) return null;
    out.push({ staffId: who === "site" ? null : who, from, until });
  }
  return out;
}
