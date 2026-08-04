import { appointmentErrorResponse, authenticateScheduling, projectSingleAppointment, resolveLabelParams, schedulingError } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { transitionStatus } from "@worker/scheduling/booking.js";

/** POST /api/scheduling/v1/appointments/{id}/complete — MACHINE endpoint. */
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { id } = await params;
  if (!isUuid(id)) return schedulingError(400, "invalid_request", "appointment id must be a valid UUID.");
  const result = await transitionStatus("completed", { tenantId: auth.auth.tenantId, appointmentId: id, actorType: "n8n" , scopeClientId: auth.auth.clientId });
  if (!result.ok) return appointmentErrorResponse(result);
  return Response.json({ appointment: await projectSingleAppointment(auth.auth, result.value, labels) });
}
