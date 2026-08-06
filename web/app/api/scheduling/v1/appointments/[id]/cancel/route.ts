import { appointmentErrorResponse, authenticateScheduling, projectSingleAppointment, resolveLabelParams } from "@/lib/schedulingApi";
import { resolveAppointmentTarget } from "@/lib/semanticParams";
import { transitionStatus } from "@worker/scheduling/booking.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/cancel — cancel (status change; never a
 * physical delete). MACHINE endpoint. The {id} may be a UUID (unchanged) OR the literal
 * `by-time`, in which case the body identifies the appointment by
 * `phone`/`email`/`external_id` + `current_day` + `current_time` — a wrong id on cancel is
 * the most destructive transcription error, so that path never guesses. Body: { reason? }.
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;
  const { id } = await params;

  // Body is optional on the UUID path (existing callers). Tolerate no/invalid JSON.
  let b: { reason?: unknown; phone?: string; email?: string; external_id?: string; current_day?: string; current_time?: string } = {};
  try {
    b = ((await req.json()) as typeof b) ?? {};
  } catch {
    b = {};
  }

  const target = await resolveAppointmentTarget(auth.auth, id, {
    phone: b.phone, email: b.email, externalId: b.external_id, currentDay: b.current_day, currentTime: b.current_time,
  });
  if (!target.ok) return target.response;
  const reason = typeof b.reason === "string" ? b.reason : null;

  const result = await transitionStatus("cancelled", {
    tenantId: auth.auth.tenantId,
    appointmentId: target.value,
    actorType: "n8n",
    reason,
    scopeClientId: auth.auth.clientId,
  });
  if (!result.ok) return appointmentErrorResponse(result);
  return Response.json({ appointment: await projectSingleAppointment(auth.auth, result.value, labels) });
}
