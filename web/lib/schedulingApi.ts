import "server-only";
import { authenticateHandoffRequest } from "@/lib/handoffApi";
import type { AppointmentRow } from "@worker/db/repositories/scheduling/appointments.js";
import type { BookingError } from "@worker/scheduling/booking.js";

/**
 * Shared auth + response helpers for the n8n-facing scheduling API
 * (app/api/scheduling/v1/*). These routes are MACHINE-only: Bearer token, no
 * session/cookies. They REUSE the existing handoff Bearer token (per-tenant
 * machine credential) — no second token concept is introduced — and only need the
 * tenant_id it resolves to, so a token for one business can never touch another.
 */

export interface SchedulingAuth {
  tenantId: string;
}

export type SchedAuthResult = { ok: true; auth: SchedulingAuth } | { ok: false; response: Response };

/** The one error-body shape: { error: { code, message } }. */
export function schedulingError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/** Authenticate a machine request and expose the token's tenant. Reuses the
 * handoff token chokepoint; a single 401 for any auth failure. */
export async function authenticateScheduling(req: Request): Promise<SchedAuthResult> {
  const result = await authenticateHandoffRequest(req);
  if (!result.ok) return { ok: false, response: result.response };
  return { ok: true, auth: { tenantId: result.auth.tenantId } };
}

/** Map a booking domain error to an HTTP status. */
export function bookingErrorStatus(error: BookingError): number {
  switch (error) {
    case "not_found":
      return 404;
    case "conflict_slot":
    case "conflict_idempotency":
    case "unavailable":
    case "no_staff":
    case "invalid_transition":
      return 409;
    default:
      return 400;
  }
}

/** The public projection of an appointment (safe to return to n8n / the customer).
 * Never leaks internal ids beyond what's needed; exposes public_reference. */
export function projectAppointment(a: AppointmentRow): Record<string, unknown> {
  return {
    id: a.id,
    public_reference: a.public_reference,
    site_id: a.site_id,
    staff_id: a.staff_id,
    service_id: a.service_id,
    contact_id: a.contact_id,
    source_conversation_id: a.source_conversation_id,
    start_at: a.start_at,
    service_end_at: a.service_end_at,
    status: a.status,
    origin: a.origin,
    service_name: a.service_name_snapshot,
    duration_min: a.duration_min_snapshot,
    price: a.price_snapshot,
    version: a.version,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };
}

/** Parse an ISO-8601 datetime query/body value → Date, or null when invalid. */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── Lightweight in-memory rate limiter (per-process) ───────────────────────────
// Good enough for a single Railway web instance to blunt public-endpoint abuse.
// Documented as best-effort (resets on deploy; not shared across instances).
const buckets = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** Best-effort client ip for rate-limit keying (behind Railway's proxy). */
export function clientIp(req: Request): string {
  const xf = req.headers.get("x-forwarded-for");
  return (xf?.split(",")[0] ?? "").trim() || req.headers.get("x-real-ip") || "unknown";
}
