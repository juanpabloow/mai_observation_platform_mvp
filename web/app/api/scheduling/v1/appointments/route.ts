import { z } from "zod";
import {
  authenticateScheduling,
  bookingErrorStatus,
  parseIsoDate,
  projectAppointment,
  schedulingError,
} from "@/lib/schedulingApi";
import { createAppointment } from "@worker/scheduling/booking.js";
import { listAppointments, type AppointmentStatus } from "@worker/db/repositories/scheduling/appointments.js";

/**
 * /api/scheduling/v1/appointments
 *
 * GET  — tenant-scoped list with safe filters (status, from/to, contact_id,
 *        conversation_id, site_id, staff_id).
 * POST — create an appointment. Requires an Idempotency-Key header (per-tenant):
 *        a repeat with the same key + payload returns the SAME appointment (200);
 *        a reused key with a different payload → 409. Resolves/creates the contact
 *        and conversation, revalidates availability, assigns a concrete staff, and
 *        the DB exclusion constraint guarantees no double-book (→ 409).
 */
export const dynamic = "force-dynamic";

const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const;

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;
  const statusParam = p.get("status");
  const status = statusParam && (STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as AppointmentStatus)
    : undefined;
  const from = parseIsoDate(p.get("from")) ?? undefined;
  const to = parseIsoDate(p.get("to")) ?? undefined;

  const rows = await listAppointments(auth.auth.tenantId, {
    siteId: p.get("site_id") ?? undefined,
    staffId: p.get("staff_id") ?? undefined,
    contactId: p.get("contact_id") ?? undefined,
    conversationId: p.get("conversation_id") ?? undefined,
    status,
    from,
    to,
    limit: 500,
  });
  return Response.json({ appointments: rows.map(projectAppointment) });
}

const CreateBody = z.object({
  workflow_ref: z.string().min(1).optional(),
  conversation_ref: z.string().min(1).max(256).optional(),
  channel: z.string().min(1).max(64).optional(),
  channel_user_id: z.string().min(1).max(256).optional(),
  customer_name: z.string().max(256).optional(),
  customer_phone: z.string().max(64).optional(),
  customer_email: z.string().max(256).optional(),
  site_id: z.string().uuid(),
  service_id: z.string().uuid(),
  staff_id: z.string().uuid().optional(),
  start_at: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req);
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
    workflowRef: b.workflow_ref ?? null,
    conversationRef: b.conversation_ref ?? null,
    channel: b.channel ?? null,
    channelUserId: b.channel_user_id ?? null,
    customerName: b.customer_name ?? null,
    customerPhone: b.customer_phone ?? null,
    customerEmail: b.customer_email ?? null,
    origin: "n8n",
    createdByType: "n8n",
    idempotencyKey,
  });

  if (!result.ok) {
    return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  }
  return Response.json({ appointment: projectAppointment(result.value) }, { status: result.deduped ? 200 : 201 });
}
