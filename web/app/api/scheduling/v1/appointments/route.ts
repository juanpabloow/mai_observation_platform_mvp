import { z } from "zod";
import {
  authenticateScheduling,
  bookingErrorStatus,
  parseIsoDate,
  projectAppointment,
  resolveOwnedSite,
  schedulingError,
} from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { createAppointment } from "@worker/scheduling/booking.js";
import { listAppointments, type AppointmentStatus } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * /api/scheduling/v1/appointments
 *
 * GET  — appointments of the RESOLVED client only (clientId is ALWAYS applied and
 *        can't be dropped by other filters). Optional site_id must belong to the
 *        client; id filters are UUID-validated to avoid a 22P02 and never widen
 *        past the client.
 * POST — create an appointment for the resolved client. Requires Idempotency-Key.
 *        Provenance is the X-Workflow-Ref header (auth.workflowRef), NEVER a body
 *        field. scopeClientId pins the booking to the resolved client.
 */
export const dynamic = "force-dynamic";

const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const;

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const statusParam = p.get("status");
  const status = statusParam && (STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as AppointmentStatus)
    : undefined;
  const from = parseIsoDate(p.get("from")) ?? undefined;
  const to = parseIsoDate(p.get("to")) ?? undefined;

  // Optional site_id must be OWNED by the resolved client (foreign/unknown → 404).
  const siteIdParam = p.get("site_id");
  let siteId: string | undefined;
  if (siteIdParam) {
    const owned = await resolveOwnedSite(auth.auth, siteIdParam);
    if (!owned.ok) return owned.response;
    siteId = owned.site.id;
  }
  // UUID-validate the other id filters so a malformed value can't 22P02 (and a
  // foreign but valid id simply matches nothing under the mandatory clientId).
  const staffIdParam = p.get("staff_id");
  const contactIdParam = p.get("contact_id");
  const conversationIdParam = p.get("conversation_id");
  for (const v of [staffIdParam, contactIdParam, conversationIdParam]) {
    if (v && !isUuid(v)) return schedulingError(400, "invalid_request", "Filter ids must be UUIDs.");
  }

  const rows = await listAppointments(auth.auth.tenantId, {
    clientId: auth.auth.clientId, // MANDATORY — never removed by other filters
    siteId,
    staffId: staffIdParam ?? undefined,
    contactId: contactIdParam ?? undefined,
    conversationId: conversationIdParam ?? undefined,
    status,
    from,
    to,
    limit: 500,
  });
  return Response.json({ appointments: rows.map(projectAppointment) });
}

// workflow_ref is deliberately ABSENT from the body: provenance comes ONLY from
// the X-Workflow-Ref header (auth.workflowRef). conversation_ref still may come
// in the body.
const CreateBody = z.object({
  conversation_ref: z.string().min(1).max(256).optional(),
  channel: z.string().min(1).max(64).optional(),
  channel_user_id: z.string().min(1).max(256).optional(),
  customer_name: z.string().max(256).optional(),
  customer_phone: z.string().max(64).optional(),
  customer_email: z.string().max(256).optional(),
  // C-2: an automation may record consent on the resolved contact (STORE-ONLY).
  messaging_consent: z.enum(["unknown", "opted_in", "opted_out"]).optional(),
  consent_source: z.string().max(256).optional(),
  site_id: z.string().uuid(),
  service_id: z.string().uuid(),
  staff_id: z.string().uuid().optional(),
  start_at: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;

  const idempotencyKey = (req.headers.get("idempotency-key") ?? "").trim();
  if (!idempotencyKey) {
    return schedulingError(400, "idempotency_key_required", "An Idempotency-Key header is required.");
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return schedulingError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = CreateBody.safeParse(json);
  if (!parsed.success) {
    return schedulingError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid request body.");
  }
  const b = parsed.data;
  const startAt = parseIsoDate(b.start_at);
  if (!startAt) return schedulingError(422, "invalid_body", "start_at must be an ISO-8601 datetime.");

  const result = await createAppointment({
    tenantId: auth.auth.tenantId,
    siteId: b.site_id,
    serviceId: b.service_id,
    staffId: b.staff_id ?? null,
    startAt,
    // Provenance is the X-Workflow-Ref header — the ONLY authority (never the body).
    workflowRef: auth.auth.workflowRef,
    conversationRef: b.conversation_ref ?? null,
    channel: b.channel ?? null,
    channelUserId: b.channel_user_id ?? null,
    customerName: b.customer_name ?? null,
    customerPhone: b.customer_phone ?? null,
    customerEmail: b.customer_email ?? null,
    messagingConsent: b.messaging_consent ?? null,
    consentSource: b.consent_source ?? null,
    origin: "n8n",
    createdByType: "n8n",
    idempotencyKey,
    // Pin to the resolved client — a foreign site → not_found, zero writes.
    scopeClientId: auth.auth.clientId,
  });

  if (!result.ok) {
    return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  }
  return Response.json({ appointment: projectAppointment(result.value) }, { status: result.deduped ? 200 : 201 });
}
