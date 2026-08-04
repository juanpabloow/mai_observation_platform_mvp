import { z } from "zod";
import {
  authenticateScheduling,
  bookingErrorStatus,
  parseIsoDate,
  projectAppointment,
  resolveLabelParams,
  schedulingError,
} from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { rescheduleAppointment } from "@worker/scheduling/booking.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/reschedule — move an appointment to a
 * new start (and optionally a new staff), keeping the SAME id. Re-validates
 * availability for the new interval and records old→new in an event. MACHINE
 * endpoint. Body: { start_at, staff_id? }.
 */
export const dynamic = "force-dynamic";

const Body = z.object({ start_at: z.string().min(1), staff_id: z.string().uuid().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { id } = await params;
  // Validate the id BEFORE reading the body (a bad id never touches the body/DB).
  if (!isUuid(id)) return schedulingError(404, "not_found", "Not found.");

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return schedulingError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return schedulingError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid body.");
  const startAt = parseIsoDate(parsed.data.start_at);
  if (!startAt) return schedulingError(422, "invalid_body", "start_at must be an ISO-8601 datetime.");

  const result = await rescheduleAppointment({
    tenantId: auth.auth.tenantId,
    appointmentId: id,
    startAt,
    staffId: parsed.data.staff_id ?? null,
    actorType: "n8n",
    scopeClientId: auth.auth.clientId,
  });
  if (!result.ok) return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  const tz = labels.tzOverride ?? (await getSiteById(auth.auth.tenantId, result.value.site_id))?.timezone ?? "UTC";
  return Response.json({ appointment: projectAppointment(result.value, tz, labels.locale) });
}
