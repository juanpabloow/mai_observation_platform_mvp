import { canAccessSchedulingSite, canAccessSchedulingStaff, getSessionScope } from "@/lib/access";
import { resolveClientModuleForScope } from "@/lib/clientModuleAccess";
import { isUuid } from "@/lib/clientModuleValidation";
import { parseIsoDate } from "@/lib/schedulingApi";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { getAppointmentById } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * GET /api/scheduling/internal/availability — SESSION-authed availability for
 * the client-scoped agenda's forms. Uses the SAME central gate as the pages and
 * actions (resolveClientModuleForScope): UUID → canAccessClient → client in
 * tenant → NOT the default client (a backfilled client_modules row for
 * Unassigned is inert) → `scheduling` enabled. Then site exists in the tenant
 * AND site.client_id === client.id; service/staff validity is enforced by the
 * loader's joins. Availability is never computed before the whole gate passes.
 *
 * EVERY failure is the same generic 404 — foreign, disabled, default, and
 * unknown are indistinguishable, and nothing leaks about other clients.
 *
 * `appointment_id` (reschedule): availability FOR MOVING THAT APPOINTMENT. It must be an
 * appointment of this client, at this site, that this login may modify (the same staff
 * predicate as gateAppointment) and still live. Then — exactly like the server check in
 * rescheduleAppointment — its own block is excluded from the busy set and its STORED
 * duration/buffers are used, and the service is the appointment's own. Every other
 * booking, break, time off and block still counts.
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

  const result = await loadAvailability({
    tenantId: scope.tenantId,
    siteId,
    serviceId: moving?.serviceId ?? serviceId,
    staffId: staffId ?? null,
    from,
    to,
    now: new Date(),
    excludeAppointmentId: moving?.id ?? null,
    timingOverride: moving?.timing ?? null,
  });
  if (!result) return notFoundResponse();
  return Response.json({
    site: { id: result.site.id, timezone: result.site.timezone },
    slots: result.slots.map((s) => ({
      start_at: s.start_at,
      service_end_at: s.service_end_at,
      staff_id: s.staff_id,
      available_staff_ids: s.available_staff_ids,
    })),
  });
}
