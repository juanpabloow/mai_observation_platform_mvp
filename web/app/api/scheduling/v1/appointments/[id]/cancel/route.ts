import { authenticateScheduling, bookingErrorStatus, projectAppointment, schedulingError } from "@/lib/schedulingApi";
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
  const { id } = await params;
  // Validate the id BEFORE reading the body (a bad id never touches the body/DB).
  if (!isUuid(id)) return schedulingError(404, "not_found", "Not found.");
  const reason = await readReason(req);

  const result = await transitionStatus("cancelled", {
    tenantId: auth.auth.tenantId,
    appointmentId: id,
    actorType: "n8n",
    reason,
    scopeClientId: auth.auth.clientId,
  });
  if (!result.ok) return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  return Response.json({ appointment: projectAppointment(result.value) });
}

async function readReason(req: Request): Promise<string | null> {
  try {
    const body = (await req.json()) as { reason?: unknown };
    return typeof body?.reason === "string" ? body.reason : null;
  } catch {
    return null;
  }
}
