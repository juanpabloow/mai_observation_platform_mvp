import { appointmentErrorResponse, authenticateScheduling, projectAppointment, resolveLabelParams, schedulingError } from "@/lib/schedulingApi";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { getContactCardById } from "@worker/db/repositories/contactIdentities.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { transitionStatus } from "@worker/scheduling/booking.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/cancel — cancel (status change; never
 * a physical delete). MACHINE endpoint. Validates the state machine, records an
 * audit event, bumps version, emits realtime after commit. Body: { reason? }.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { id } = await params;
  // Validate the id BEFORE reading the body (a bad id never touches the body/DB).
  if (!isUuid(id)) return schedulingError(400, "invalid_request", "appointment id must be a valid UUID.");
  const reason = await readReason(req);

  const result = await transitionStatus("cancelled", {
    tenantId: auth.auth.tenantId,
    appointmentId: id,
    actorType: "n8n",
    reason,
    scopeClientId: auth.auth.clientId,
  });
  if (!result.ok) return appointmentErrorResponse(result);
  const tz = labels.tzOverride ?? (await getSiteById(auth.auth.tenantId, result.value.site_id))?.timezone ?? "UTC";
  const contact = result.value.contact_id ? await getContactCardById(auth.auth.tenantId, auth.auth.clientId, result.value.contact_id) : null;
  return Response.json({ appointment: projectAppointment(result.value, tz, labels.locale, contact) });
}

async function readReason(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as { reason?: unknown };
    return typeof body?.reason === "string" ? body.reason : null;
  } catch {
    return null;
  }
}
