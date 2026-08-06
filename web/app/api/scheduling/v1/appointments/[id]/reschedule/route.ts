import { z } from "zod";
import {
  appointmentErrorResponse,
  authenticateScheduling,
  bookingErrorStatus,
  projectSingleAppointment,
  resolveLabelParams,
  schedulingError,
} from "@/lib/schedulingApi";
import { nearestTimesHint, resolveAppointmentTarget, resolveStaffParam, resolveStartParam } from "@/lib/semanticParams";
import { rescheduleAppointment } from "@worker/scheduling/booking.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getAppointmentById } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/reschedule — move an appointment to a new start
 * (and optionally a new staff), keeping the SAME id. Re-validates availability for the new
 * interval and records old→new in an event. MACHINE endpoint. SEMANTIC alternatives:
 *   - {id} may be a UUID OR the literal `by-time`, then the body identifies the appointment
 *     by `phone`/`email`/`external_id` + `current_day` + `current_time`.
 *   - the NEW slot may be `start_at` (ISO) OR `day` + `time` (site-local).
 *   - the new staff may be `staff_id` OR `staff` (name); omit to keep the current staff.
 */
export const dynamic = "force-dynamic";

const Body = z.object({
  // §3 identify (only when the path segment is `by-time`):
  phone: z.string().max(64).optional(),
  email: z.string().max(256).optional(),
  external_id: z.string().max(256).optional(),
  current_day: z.string().max(10).optional(),
  current_time: z.string().max(16).optional(),
  // new slot (§2):
  start_at: z.string().min(1).optional(),
  day: z.string().max(10).optional(),
  time: z.string().max(16).optional(),
  // new staff:
  staff_id: z.string().uuid().optional(),
  staff: z.string().max(256).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { id } = await params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return schedulingError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return schedulingError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid body.");
  const b = parsed.data;

  // Identify the appointment (UUID path OR by-time from the body).
  const target = await resolveAppointmentTarget(auth.auth, id, {
    phone: b.phone, email: b.email, externalId: b.external_id, currentDay: b.current_day, currentTime: b.current_time,
  });
  if (!target.ok) return target.response;

  // Need the appointment's SITE tz to interpret a local day+time (and for the response).
  const appt = await getAppointmentById(auth.auth.tenantId, target.value);
  if (!appt || appt.client_id !== auth.auth.clientId) {
    return schedulingError(404, "appointment_not_found", "No appointment with that id exists for this client. Call GET /api/scheduling/v1/appointments to list valid ids.");
  }
  const siteTz = (await getSiteById(auth.auth.tenantId, appt.site_id))?.timezone ?? "UTC";

  const start = resolveStartParam(b.start_at, b.day, b.time, siteTz);
  if (!start.ok) return start.response;
  const stf = await resolveStaffParam(auth.auth, appt.site_id, b.staff_id, b.staff);
  if (!stf.ok) return stf.response;

  const result = await rescheduleAppointment({
    tenantId: auth.auth.tenantId,
    appointmentId: target.value,
    startAt: start.value,
    staffId: stf.value,
    actorType: "n8n",
    scopeClientId: auth.auth.clientId,
  });
  if (!result.ok) {
    if (result.error === "unavailable" || result.error === "no_staff" || result.error === "conflict_slot") {
      const hint = await nearestTimesHint(auth.auth, appt.site_id, appt.service_id, stf.value, start.value, siteTz);
      return schedulingError(bookingErrorStatus(result.error), result.error, result.message + hint);
    }
    return appointmentErrorResponse(result);
  }
  return Response.json({ appointment: await projectSingleAppointment(auth.auth, result.value, labels) });
}
