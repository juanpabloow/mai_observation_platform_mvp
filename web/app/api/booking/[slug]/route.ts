import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  bookingErrorStatus,
  checkRateLimit,
  clientIp,
  parseIsoDate,
  schedulingError,
} from "@/lib/schedulingApi";
import { getPublicBookingSiteBySlug } from "@worker/db/repositories/scheduling/sites.js";
import { getStaffById } from "@worker/db/repositories/scheduling/staff.js";
import { createAppointment } from "@worker/scheduling/booking.js";

/**
 * POST /api/booking/{slug} — PUBLIC booking creation. Resolves the site by slug,
 * runs the SAME booking engine (availability revalidation + exclusion-constraint
 * anti-double-book), and returns a customer-facing confirmation. Rate-limited by
 * IP (bookings are far scarcer than reads). Idempotency-Key header optional — the
 * flow sends a per-attempt uuid so retries dedupe; absent, one is generated.
 */
export const dynamic = "force-dynamic";

const Body = z.object({
  service_id: z.string().uuid(),
  staff_id: z.string().uuid().optional(),
  start_at: z.string().min(1),
  customer_name: z.string().min(1).max(256),
  customer_phone: z.string().min(1).max(64),
  customer_email: z.string().max(256).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }): Promise<Response> {
  if (!checkRateLimit(`book-write:${clientIp(req)}`, 8, 60_000)) {
    return schedulingError(429, "rate_limited", "Too many booking attempts. Please try again shortly.");
  }
  const { slug } = await params;

  // GATE FIRST: resolve the public booking site before reading/parsing any body.
  // A disabled/unknown/default/inactive site returns the generic 404 even for an
  // invalid or empty body — the module gate never leaks through input validation.
  const site = await getPublicBookingSiteBySlug(slug);
  if (!site) return schedulingError(404, "not_found", "Booking page not found.");

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return schedulingError(422, "invalid_body", "Request body must be valid JSON.");
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return schedulingError(422, "invalid_body", parsed.error.issues[0]?.message ?? "Invalid body.");
  const startAt = parseIsoDate(parsed.data.start_at);
  if (!startAt) return schedulingError(422, "invalid_body", "start_at must be an ISO-8601 datetime.");

  const idempotencyKey = (req.headers.get("idempotency-key") ?? "").trim() || `pub_${randomUUID()}`;
  const result = await createAppointment({
    tenantId: site.tenant_id,
    siteId: site.id,
    serviceId: parsed.data.service_id,
    staffId: parsed.data.staff_id ?? null,
    startAt,
    // Public bookings identify the customer by phone (the stable channel id).
    channel: "public",
    channelUserId: parsed.data.customer_phone,
    customerName: parsed.data.customer_name,
    customerPhone: parsed.data.customer_phone,
    customerEmail: parsed.data.customer_email ?? null,
    origin: "public",
    createdByType: "public",
    idempotencyKey,
    // Defense in depth: the booking engine rejects any site/appointment outside
    // this client (the resolver already proved the site's client hosts booking).
    scopeClientId: site.client_id,
  });

  if (!result.ok) {
    // A CONCURRENT disable (module turned off between the gate and the commit)
    // surfaces as module_disabled — collapse it to the SAME generic 404 the gate
    // uses, never a 403 that would reveal the site once existed here.
    if (result.error === "module_disabled") {
      return schedulingError(404, "not_found", "Booking page not found.");
    }
    return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
  }
  const a = result.value;
  const staff = await getStaffById(site.tenant_id, a.staff_id);
  return Response.json(
    {
      confirmation: {
        reference: a.public_reference,
        site: site.name,
        service: a.service_name_snapshot,
        staff_name: staff?.name ?? null,
        start_at: a.start_at,
        service_end_at: a.service_end_at,
        timezone: site.timezone,
        status: a.status,
      },
    },
    { status: result.deduped ? 200 : 201 },
  );
}
