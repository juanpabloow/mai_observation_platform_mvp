import { authenticateScheduling, bookingErrorStatus, projectAppointment, schedulingError } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { transitionStatus } from "@worker/scheduling/booking.js";

/** POST /api/scheduling/v1/appointments/{id}/no-show — MACHINE endpoint. */
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return schedulingError(404, "not_found", "Not found.");
  const result = await transitionStatus("no_show", { tenantId: auth.auth.tenantId, appointmentId: id, actorType: "n8n" , scopeClientId: auth.auth.clientId });
  if (!result.ok) return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  return Response.json({ appointment: projectAppointment(result.value) });
}
