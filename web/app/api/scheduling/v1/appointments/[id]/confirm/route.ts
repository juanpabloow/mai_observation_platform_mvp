import { appointmentErrorResponse, authenticateScheduling, projectAppointment, resolveLabelParams, schedulingError } from "@/lib/schedulingApi";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getContactCardById } from "@worker/db/repositories/contactIdentities.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { transitionStatus } from "@worker/scheduling/booking.js";

/** POST /api/scheduling/v1/appointments/{id}/confirm — MACHINE endpoint. */
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { id } = await params;
  if (!isUuid(id)) return schedulingError(400, "invalid_request", "appointment id must be a valid UUID.");
  const result = await transitionStatus("confirmed", { tenantId: auth.auth.tenantId, appointmentId: id, actorType: "n8n" , scopeClientId: auth.auth.clientId });
  if (!result.ok) return appointmentErrorResponse(result);
  const tz = labels.tzOverride ?? (await getSiteById(auth.auth.tenantId, result.value.site_id))?.timezone ?? "UTC";
  const contact = result.value.contact_id ? await getContactCardById(auth.auth.tenantId, auth.auth.clientId, result.value.contact_id) : null;
  return Response.json({ appointment: projectAppointment(result.value, tz, labels.locale, contact) });
}
