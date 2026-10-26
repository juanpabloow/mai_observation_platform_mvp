import { authenticateScheduling, schedulingError } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { validateBetterAuthUrl } from "@/lib/auth-verification";
import { reviewLinkSecret, reviewPath, signReviewToken } from "@/lib/reviewLink";
import { getAppointmentById } from "@worker/db/repositories/scheduling/appointments.js";
import { ensureReviewRequest } from "@worker/db/repositories/scheduling/reviews.js";
import { isRegisteredAfterService } from "@worker/scheduling/pastAttendance.js";

/**
 * POST /api/scheduling/v1/appointments/{id}/review-link — MACHINE endpoint (n8n).
 *
 * The review link of a COMPLETED appointment of the token's client, to send to the
 * customer. Idempotent: the first call creates the review request, every later call
 * returns the SAME link (renewed for 30 days if it expired unanswered). Sends nothing
 * itself — delivering the link is the caller's job.
 *
 *   200 { review_link: { url, path, status: "requested" | "answered", expires_at } }
 *   404 unknown / other client's appointment · 409 not completed · 503 no link secret
 *   409 registered_after_service — a visit recorded in the agenda only after it ended
 *       («Registrar atención realizada»): writing it down must never make an automation ask
 *       the customer for a review. A person can still copy its link from the agenda.
 */
export const dynamic = "force-dynamic";

function publicBase(): string | null {
  try {
    return validateBetterAuthUrl(process.env.BETTER_AUTH_URL, { enforceProduction: false });
  } catch {
    return null;
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!isUuid(id)) return schedulingError(400, "invalid_request", "appointment id must be a valid UUID.");
  const { tenantId, clientId } = auth.auth;

  const appt = await getAppointmentById(tenantId, id);
  if (!appt || appt.client_id !== clientId) return schedulingError(404, "not_found", "Appointment not found.");
  if (appt.status !== "completed") return schedulingError(409, "not_completed", "Only a completed appointment can be reviewed.");
  if (isRegisteredAfterService(appt)) {
    return schedulingError(409, "registered_after_service", "This visit was recorded after it happened; no review request is created for it.");
  }

  const secret = reviewLinkSecret();
  if (!secret) return schedulingError(503, "unavailable", "Review links are not configured.");
  const request = await ensureReviewRequest(tenantId, clientId, id);
  if (!request) return schedulingError(404, "not_found", "Appointment not found.");

  const path = reviewPath(signReviewToken(request.id, secret));
  const base = publicBase();
  return Response.json({
    review_link: {
      url: base ? `${base}${path}` : null,
      path,
      status: request.status === "requested" ? "requested" : "answered",
      expires_at: new Date(request.expires_at).toISOString(),
    },
  });
}
