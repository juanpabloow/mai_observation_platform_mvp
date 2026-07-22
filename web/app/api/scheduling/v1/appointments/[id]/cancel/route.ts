import { authenticateScheduling, bookingErrorStatus, projectAppointment, schedulingError } from "@/lib/schedulingApi";
import { transitionStatus } from "@worker/scheduling/booking.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/cancel — cancel (status change; never
 * a physical delete). MACHINE endpoint. Validates the state machine, records an
 * audit event, bumps version, emits realtime after commit. Body: { reason? }.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const reason = await readReason(req);

  const result = await transitionStatus("cancelled", {
    tenantId: auth.auth.tenantId,
    appointmentId: id,
    actorType: "n8n",
    reason,
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
