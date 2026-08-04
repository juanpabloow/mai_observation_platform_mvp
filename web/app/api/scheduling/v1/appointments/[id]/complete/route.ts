import { authenticateScheduling, bookingErrorStatus, projectAppointment, resolveLabelParams, schedulingError } from "@/lib/schedulingApi";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
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
  if (!isUuid(id)) return schedulingError(404, "not_found", "Not found.");
  const result = await transitionStatus("completed", { tenantId: auth.auth.tenantId, appointmentId: id, actorType: "n8n" , scopeClientId: auth.auth.clientId });
  if (!result.ok) return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  const tz = labels.tzOverride ?? (await getSiteById(auth.auth.tenantId, result.value.site_id))?.timezone ?? "UTC";
  return Response.json({ appointment: projectAppointment(result.value, tz, labels.locale) });
}
