import "server-only";
import { authenticateHandoffRequest } from "@/lib/handoffApi";
import type { Capability } from "@worker/db/repositories/handoffTokens.js";
import { isUuid } from "@/lib/clientModuleValidation";
import { localTimeFields, isValidTimeZone, isSupportedLocale, DEFAULT_LABEL_LOCALE } from "@/lib/localTime";
import type { AppointmentRow } from "@worker/db/repositories/scheduling/appointments.js";
import type { BookingError } from "@worker/scheduling/booking.js";
import { resolveMachineSchedulingScope } from "@worker/scheduling/machineScope.js";
import { parseWorkflowRef } from "@worker/scheduling/workflowRef.js";
import { getSiteById, type SiteRow } from "@worker/db/repositories/scheduling/sites.js";

/**
 * Shared auth + scope for the n8n-facing scheduling API (app/api/scheduling/v1/*).
 * MACHINE-only: Bearer token + an X-Workflow-Ref header. The chain is:
 *
 *   Bearer token → tenant + n8n connection (handoff token)
 *   → X-Workflow-Ref → the workflow synced under THAT connection
 *   → its client_id → non-default client → scheduling enabled
 *
 * So a token can only ever act on the ONE client its X-Workflow-Ref resolves to;
 * it can never use another connection's workflow or reach another client's
 * sites/appointments/contacts/staff. tenant_id and client_id are NEVER accepted
 * from the request — they are derived here. Routes must NOT re-resolve tenant or
 * client on their own.
 */

export interface SchedulingAuth {
  tenantId: string;
  connectionId: string;
  tokenId: string;
  /** The n8n workflow id from X-Workflow-Ref (authoritative provenance). */
  workflowRef: string;
  /** The workflow's owning client — the ONLY client this request may touch. */
  clientId: string;
}

export type SchedAuthResult = { ok: true; auth: SchedulingAuth } | { ok: false; response: Response };

/** The one error-body shape: { error: { code, message } }. */
export function schedulingError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * THE auth + scope chokepoint. Authenticates FIRST (a request without valid
 * credentials never sees body/query validation), then requires X-Workflow-Ref and
 * resolves the machine scope:
 *  - no/invalid/revoked token, OR a token WITHOUT the required capability → the handoff
 *    401 (indistinguishable; capability is checked in the chokepoint before scope).
 *  - token ok but X-Workflow-Ref missing/blank → 400 workflow_ref_required.
 *  - unknown/wrong-connection/wrong-tenant workflow → 404 not_found (Workflow not found).
 *  - workflow on the default client, or scheduling absent/disabled → 403 module_disabled.
 *
 * `capability` is `scheduling.read` for reads and `scheduling.write` for mutations —
 * declared once per route.
 */
export async function authenticateScheduling(req: Request, capability: Capability): Promise<SchedAuthResult> {
  const result = await authenticateHandoffRequest(req, capability);
  if (!result.ok) return { ok: false, response: result.response };
  const { tenantId, connectionId, tokenId } = result.auth;

  const workflowRef = parseWorkflowRef(req.headers.get("x-workflow-ref"));
  if (!workflowRef) {
    return {
      ok: false,
      response: schedulingError(400, "workflow_ref_required", "X-Workflow-Ref header is required."),
    };
  }

  const scope = await resolveMachineSchedulingScope({ tenantId, connectionId, workflowRef });
  if (!scope.ok) {
    if (scope.reason === "workflow_not_found") {
      return { ok: false, response: schedulingError(404, "not_found", "Workflow not found.") };
    }
    return {
      ok: false,
      response: schedulingError(403, "module_disabled", "Scheduling module is disabled for this client."),
    };
  }

  return { ok: true, auth: { tenantId, connectionId, tokenId, workflowRef: scope.workflowRef, clientId: scope.clientId } };
}

/**
 * Resolve a `site_id` request value to a site OWNED BY the authenticated client.
 *
 * Post-AUTH resource errors are SPECIFIC (the caller already has full access to this
 * client's data, so naming the resource leaks nothing), and a foreign site is
 * indistinguishable from a nonexistent one (both → `site_not_found`) so nothing
 * cross-client leaks:
 *   - malformed UUID              → 400 invalid_request  (a client mistake, never a 404)
 *   - unknown / another client's  → 404 site_not_found   (actionable: list valid ids)
 *   - exists but deactivated,     → 409 site_inactive    (only when opts.requireActive —
 *     and requireActive             so the caller can tell "wrong id" from "deactivated")
 *
 * `requireActive` is TRUE for availability / services / staff / new bookings (an inactive
 * site can't be booked) and FALSE for reads of EXISTING data (the appointments list must
 * still show a deactivated site's history — deactivation is forward-looking).
 */
export async function resolveOwnedSite(
  auth: SchedulingAuth,
  siteId: string | null | undefined,
  opts: { requireActive?: boolean } = {},
): Promise<{ ok: true; site: SiteRow } | { ok: false; response: Response }> {
  if (!siteId || !isUuid(siteId)) {
    return { ok: false, response: schedulingError(400, "invalid_request", "site_id must be a valid UUID.") };
  }
  const site = await getSiteById(auth.tenantId, siteId);
  if (!site || site.client_id !== auth.clientId) {
    return {
      ok: false,
      response: schedulingError(
        404,
        "site_not_found",
        "No site with that id exists for this client. Call GET /api/scheduling/v1/sites to list valid site ids.",
      ),
    };
  }
  if (opts.requireActive && !site.active) {
    return {
      ok: false,
      response: schedulingError(
        409,
        "site_inactive",
        "This site exists but is deactivated, so it can’t be used for availability or new bookings. Reactivate it in scheduling settings, or use a different site_id (GET /api/scheduling/v1/sites lists active sites).",
      ),
    };
  }
  return { ok: true, site };
}

/** Map a booking domain error to an HTTP status. */
export function bookingErrorStatus(error: BookingError): number {
  switch (error) {
    case "not_found":
      return 404;
    case "module_disabled":
      return 403;
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

/**
 * Translate a booking-engine error into a SPECIFIC, actionable machine-API response
 * WITHOUT touching the engine (its `not_found` is also the cross-client security guard and
 * is byte-identical across tests). A transition/read only fails "not found" because the
 * appointment doesn't exist for this client (a cross-client id stays indistinguishable —
 * still `appointment_not_found`); every other error keeps its own code + message.
 */
export function appointmentErrorResponse(result: { error: BookingError; message: string }): Response {
  if (result.error === "not_found") {
    return schedulingError(
      404,
      "appointment_not_found",
      "No appointment with that id exists for this client. Call GET /api/scheduling/v1/appointments to list valid ids.",
    );
  }
  return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
}

/**
 * Same idea for CREATE: the create route pre-validates site/service/staff, so a residual
 * engine `not_found` means the service isn't bookable at this site. Map it to the specific,
 * actionable `service_not_found`; keep conflicts/unavailable/no_staff/module_disabled as-is.
 */
export function createErrorResponse(result: { error: BookingError; message: string }): Response {
  if (result.error === "not_found") {
    return schedulingError(
      404,
      "service_not_found",
      "That service isn’t bookable at this site. Call GET /api/scheduling/v1/services?site_id=… to get valid service ids.",
    );
  }
  return schedulingError(bookingErrorStatus(result.error), result.error, result.message);
}

/** The public projection of an appointment (safe to return to n8n / the customer).
 * Never leaks internal ids beyond what's needed; exposes public_reference.
 *
 * C-6 additive: `start_at`/`service_end_at` stay UTC (the canonical value to pass back
 * when booking); the *_local / *_label / date_label / day fields are display-only,
 * formatted in `tz` (the site's timezone unless a `tz` param overrode it) + `locale`.
 *
 * C-7 additive: `contact` = { id, name, primary_identity } | null so a human/agent can
 * tell whose appointment it is (not just a UUID). `contact_id` is unchanged. */
export interface AppointmentContact {
  id: string;
  name: string | null;
  primary_identity: string | null;
}
export function projectAppointment(
  a: AppointmentRow,
  tz: string,
  locale: string = DEFAULT_LABEL_LOCALE,
  contact: AppointmentContact | null = null,
): Record<string, unknown> {
  return {
    id: a.id,
    public_reference: a.public_reference,
    site_id: a.site_id,
    staff_id: a.staff_id,
    service_id: a.service_id,
    contact_id: a.contact_id,
    contact,
    source_conversation_id: a.source_conversation_id,
    start_at: a.start_at,
    service_end_at: a.service_end_at,
    ...localTimeFields(a.start_at, a.service_end_at, tz, locale),
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

/**
 * Resolve the optional `tz` + `locale` presentation params (C-6). `tz` defaults to the
 * caller-supplied site tz (per route); `locale` defaults to es-CO. An unknown IANA tz or
 * unsupported locale → 400 naming the parameter (an agent reads the message) — NEVER a
 * silent UTC fallback, which is how a wrong hour reaches a customer. Returns the override
 * tz (or null to mean "use the context default") + the resolved locale.
 */
export function resolveLabelParams(req: Request): { ok: true; tzOverride: string | null; locale: string } | { ok: false; response: Response } {
  const p = new URL(req.url).searchParams;
  const tzParam = (p.get("tz") ?? "").trim();
  const localeParam = (p.get("locale") ?? "").trim();
  if (tzParam && !isValidTimeZone(tzParam)) {
    return { ok: false, response: schedulingError(400, "invalid_request", `tz is not a valid IANA timezone name: ${tzParam}`) };
  }
  if (localeParam && !isSupportedLocale(localeParam)) {
    return { ok: false, response: schedulingError(400, "invalid_request", `locale is not supported: ${localeParam}`) };
  }
  return { ok: true, tzOverride: tzParam || null, locale: localeParam || DEFAULT_LABEL_LOCALE };
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
