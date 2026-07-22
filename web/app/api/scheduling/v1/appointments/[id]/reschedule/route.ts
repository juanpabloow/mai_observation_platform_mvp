import { z } from "zod";
import {
  authenticateScheduling,
  bookingErrorStatus,
  parseIsoDate,
  projectAppointment,
  schedulingError,
} from "@/lib/schedulingApi";
import { rescheduleAppointment } from "@worker/scheduling/booking.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/reschedule — move an appointment to a
 * new start (and optionally a new staff), keeping the SAME id. Re-validates
 * availability for the new interval and records old→new in an event. MACHINE
 * endpoint. Body: { start_at, staff_id? }.
 */
export const dynamic = "force-dynamic";

const Body = z.object({ start_at: z.string().min(1), staff_id: z.string().uuid().optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;

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
  });
  if (!result.ok) return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  return Response.json({ appointment: projectAppointment(result.value) });
}
