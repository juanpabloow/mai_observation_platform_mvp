import { z } from "zod";
import {
  authenticateScheduling,
  bookingErrorStatus,
  createErrorResponse,
  parseIsoDate,
  projectAppointment,
  projectSingleAppointment,
  resolveLabelParams,
  resolveOwnedSite,
  schedulingError,
} from "@/lib/schedulingApi";
import { nearestTimesHint, resolveServiceParam, resolveStaffParam, resolveStartParam } from "@/lib/semanticParams";
import { dateLabel, localClock24, localDay, timeLabel } from "@/lib/localTime";
import { isUuid } from "@/lib/clientModuleValidation";
import { createAppointment } from "@worker/scheduling/booking.js";
import { listAppointments, type AppointmentStatus } from "@worker/db/repositories/scheduling/appointments.js";
import { staffBelongsToClient } from "@worker/db/repositories/scheduling/staff.js";
import { findContactIdsByIdentity, contactBelongsToClient } from "@worker/db/repositories/contactIdentities.js";
import { identitiesSchema } from "@/lib/identities";

/**
 * /api/scheduling/v1/appointments
 *
 * GET  — appointments of the RESOLVED client only (clientId is ALWAYS applied and
 *        can't be dropped by other filters). Optional site_id must belong to the
 *        client; id filters are UUID-validated to avoid a 22P02 and never widen
 *        past the client.
 *
 *        C-7 param discipline — a filter the caller asked for must NEVER be
 *        silently ignored (that is how a scoped query widened to the whole
 *        client). So: an UNKNOWN param → 400 naming it; a recognized param with
 *        an EMPTY value → 400 (previously `?contact_id=` dropped the filter); an
 *        invalid status / from / to / active value → 400 (previously silently
 *        dropped). Identity filters (phone/email/external_id) resolve through the
 *        C-2 identity spine to a contact-id set; an identity that matches NObody
 *        yields 0 rows (never the whole client) and excludes walk-ins (NULL
 *        contact_id). `status` accepts one-or-more values, WITHOUT any time bound
 *        (status=scheduled returns past scheduled rows too). `active=true` is the
 *        DIFFERENT "still actionable" filter: status IN (scheduled, confirmed) AND
 *        service_end_at >= now — so it never returns appointments that already ended.
 * POST — create an appointment for the resolved client. Requires Idempotency-Key.
 *        Provenance is the X-Workflow-Ref header (auth.workflowRef), NEVER a body
 *        field. scopeClientId pins the booking to the resolved client.
 */
export const dynamic = "force-dynamic";

const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "no_show"] as const;
// The exhaustive set of query params GET understands. Anything else → 400 (a typo'd
// or unsupported param like `?phone` on an old build must be LOUD, never ignored).
const ALLOWED_PARAMS = new Set([
  "status", "active", "from", "to", "site_id", "staff_id", "contact_id",
  "conversation_id", "phone", "email", "external_id", "tz", "locale", "compact",
]);

export async function GET(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.read");
  if (!auth.ok) return auth.response;
  const p = new URL(req.url).searchParams;

  // (1) Reject UNKNOWN params — never silently ignore a filter the caller sent.
  const unknown = [...new Set([...p.keys()].filter((k) => !ALLOWED_PARAMS.has(k)))];
  if (unknown.length) {
    return schedulingError(400, "unknown_parameter", `Unknown query parameter(s): ${unknown.join(", ")}.`);
  }
  // (2) Reject EMPTY-valued recognized params — an empty value is an unfinished
  // filter, and treating it as "absent" is exactly what widened the query.
  const empty = [...new Set([...p.keys()].filter((k) => (p.get(k) ?? "").trim() === ""))];
  if (empty.length) {
    return schedulingError(400, "empty_parameter", `Parameter(s) sent with an empty value: ${empty.join(", ")}.`);
  }

  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;

  // status: one or more (comma-separated and/or repeated). An unknown value 400s.
  const statusSet = new Set<AppointmentStatus>();
  for (const raw of p.getAll("status")) {
    for (const part of raw.split(",")) {
      const s = part.trim();
      if (!s) continue;
      if (!(STATUSES as readonly string[]).includes(s)) {
        return schedulingError(400, "invalid_request", `Unknown status value: ${s}.`);
      }
      statusSet.add(s as AppointmentStatus);
    }
  }
  // active=true → "still actionable": status IN (scheduled, confirmed) AND not yet ended
  // (service_end_at >= now). This is a SEPARATE filter from `status=`, NOT a status alias —
  // `status=scheduled` still returns past scheduled rows, whatever the date; `active=true`
  // never does. Only true/false allowed; `active=false` is a no-op (the unfiltered list
  // already spans every status and date). The boundary is an absolute instant, so `tz`
  // (a label-only param) cannot shift what the filter returns.
  let activeAt: Date | undefined;
  const activeParam = p.get("active");
  if (activeParam != null) {
    if (activeParam !== "true" && activeParam !== "false") {
      return schedulingError(400, "invalid_request", "active must be 'true' or 'false'.");
    }
    if (activeParam === "true") activeAt = new Date();
  }
  const status = statusSet.size ? [...statusSet] : undefined;

  // from/to: an invalid datetime 400s rather than silently dropping the window.
  let from: Date | undefined;
  const fromParam = p.get("from");
  if (fromParam != null) {
    const d = parseIsoDate(fromParam);
    if (!d) return schedulingError(400, "invalid_request", "from must be an ISO-8601 datetime.");
    from = d;
  }
  let to: Date | undefined;
  const toParam = p.get("to");
  if (toParam != null) {
    const d = parseIsoDate(toParam);
    if (!d) return schedulingError(400, "invalid_request", "to must be an ISO-8601 datetime.");
    to = d;
  }

  // Optional site_id must be OWNED by the resolved client. NO requireActive: this is a
  // read of EXISTING data, so a deactivated site's appointments must still be listable
  // (deactivation is forward-looking) — a foreign/unknown site is still site_not_found.
  const siteIdParam = p.get("site_id");
  let siteId: string | undefined;
  if (siteIdParam) {
    const owned = await resolveOwnedSite(auth.auth, siteIdParam);
    if (!owned.ok) return owned.response;
    siteId = owned.site.id;
  }
  // UUID-validate the other id filters so a malformed value can't 22P02.
  const staffIdParam = p.get("staff_id");
  const contactIdParam = p.get("contact_id");
  const conversationIdParam = p.get("conversation_id");
  for (const v of [staffIdParam, contactIdParam, conversationIdParam]) {
    if (v && !isUuid(v)) return schedulingError(400, "invalid_request", "Filter ids must be UUIDs.");
  }
  // §3: a well-formed but NONEXISTENT filter id must fail LOUDLY — never a silent empty
  // list (that is exactly how a fabricated contact_id read back as "you have no
  // appointments"). A foreign id is indistinguishable from a nonexistent one (both →
  // *_not_found), so nothing cross-client leaks. Historical filters, so active is ignored.
  if (staffIdParam && !(await staffBelongsToClient(auth.auth.tenantId, auth.auth.clientId, staffIdParam))) {
    return schedulingError(404, "staff_not_found", "No staff with that id exists for this client. Call GET /api/scheduling/v1/staff?site_id=… to get valid staff ids.");
  }
  if (contactIdParam && !(await contactBelongsToClient(auth.auth.tenantId, auth.auth.clientId, contactIdParam))) {
    return schedulingError(404, "contact_not_found", "No contact with that id exists for this client. Resolve it via GET /api/crm/v1/contacts/lookup or POST /api/crm/v1/contacts/upsert.");
  }

  // Identity filters (C-2 spine): resolve phone/email/external_id → a contact-id set.
  // When ANY is present we pass `contactIds` (possibly []), so no-match → 0 rows,
  // never the whole client. `= ANY(...)` excludes NULL, so walk-ins are excluded.
  const phoneParam = p.get("phone");
  const emailParam = p.get("email");
  const externalIdParam = p.get("external_id");
  let contactIds: string[] | undefined;
  if (phoneParam != null || emailParam != null || externalIdParam != null) {
    contactIds = await findContactIdsByIdentity({
      tenantId: auth.auth.tenantId,
      clientId: auth.auth.clientId,
      phone: phoneParam ?? undefined,
      email: emailParam ?? undefined,
      channelUserId: externalIdParam ?? undefined,
    });
  }

  const rows = await listAppointments(auth.auth.tenantId, {
    clientId: auth.auth.clientId, // MANDATORY — never removed by other filters
    siteId,
    staffId: staffIdParam ?? undefined,
    contactId: contactIdParam ?? undefined,
    contactIds,
    conversationId: conversationIdParam ?? undefined,
    status,
    activeAt,
    from,
    to,
    limit: 500,
  });
  // Per-row timezone (the list can span sites): the ?tz override, else each row's site tz.
  // Contact card comes from the row's join (contact_id is NULL for walk-ins / foreign).
  // staff_name (E-4) is already on the row from the list query — no per-row lookup.
  const compact = p.get("compact") === "true";
  return Response.json({
    appointments: rows.map((r) => {
      const tz = labels.tzOverride ?? r.site_timezone;
      const contact = r.contact_id ? { id: r.contact_id, name: r.contact_name, primary_identity: r.primary_identity } : null;
      if (!compact) return projectAppointment(r, tz, labels.locale, contact, r.staff_name);
      // E-4 compact: only what a conversational caller needs to read + act on.
      return {
        id: r.id,
        status: r.status,
        service_name: r.service_name_snapshot,
        staff_name: r.staff_name,
        day: localDay(r.start_at, tz),
        date_label: dateLabel(r.start_at, tz, labels.locale),
        start_label: timeLabel(r.start_at, tz, labels.locale),
        end_label: timeLabel(r.service_end_at, tz, labels.locale),
        time: localClock24(r.start_at, tz),
        contact: contact ? { name: contact.name } : null,
      };
    }),
  });
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
  // Service/staff by opaque id OR by NAME (an LLM transcribes a name reliably; a UUID it
  // sometimes corrupts by one character). start by ISO `start_at` OR local `day` + `time`.
  service_id: z.string().uuid().optional(),
  service: z.string().min(1).max(256).optional(),
  staff_id: z.string().uuid().optional(),
  staff: z.string().min(1).max(256).optional(),
  start_at: z.string().min(1).optional(),
  day: z.string().min(1).max(10).optional(),
  time: z.string().min(1).max(16).optional(),
  // I-1: additional identities for the appointment's contact (the attendee), attached through
  // the same identity chokepoint. Ignored on the explicit contact_id path (never mutates).
  identities: identitiesSchema,
});

export async function POST(req: Request): Promise<Response> {
  const auth = await authenticateScheduling(req, "scheduling.write");
  if (!auth.ok) return auth.response;
  const labels = resolveLabelParams(req);
  if (!labels.ok) return labels.response;

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

  // Resolve the semantic parameters server-side (site by id; service/staff by id OR name;
  // start by ISO OR site-local day+time). Each returns a SPECIFIC, actionable error. The
  // engine still re-validates everything under scopeClientId — this is defense-in-depth.
  const site = await resolveOwnedSite(auth.auth, b.site_id, { requireActive: true });
  if (!site.ok) return site.response;
  const svc = await resolveServiceParam(auth.auth, site.site.id, b.service_id, b.service);
  if (!svc.ok) return svc.response;
  const stf = await resolveStaffParam(auth.auth, site.site.id, b.staff_id, b.staff);
  if (!stf.ok) return stf.response;
  const start = resolveStartParam(b.start_at, b.day, b.time, site.site.timezone);
  if (!start.ok) return start.response;
  const startAt = start.value;

  const result = await createAppointment({
    tenantId: auth.auth.tenantId,
    siteId: b.site_id,
    serviceId: svc.value,
    staffId: stf.value,
    startAt,
    // Provenance is the X-Workflow-Ref header — the ONLY authority (never the body).
    workflowRef: auth.auth.workflowRef,
    conversationRef: b.conversation_ref ?? null,
    channel: b.channel ?? null,
    channelUserId: b.channel_user_id ?? null,
    customerName: b.customer_name ?? null,
    customerPhone: b.customer_phone ?? null,
    customerEmail: b.customer_email ?? null,
    identities: b.identities,
    messagingConsent: b.messaging_consent ?? null,
    consentSource: b.consent_source ?? null,
    origin: "n8n",
    createdByType: "n8n",
    idempotencyKey,
    // Pin to the resolved client — a foreign site → not_found, zero writes.
    scopeClientId: auth.auth.clientId,
  });

  if (!result.ok) {
    // A slot problem gets the nearest real times THAT day appended, so the agent can
    // re-offer immediately instead of guessing (§2).
    if (result.error === "unavailable" || result.error === "no_staff" || result.error === "conflict_slot") {
      const hint = await nearestTimesHint(auth.auth, site.site.id, svc.value, stf.value, startAt, site.site.timezone, labels.locale);
      return schedulingError(bookingErrorStatus(result.error), result.error, result.message + hint);
    }
    return createErrorResponse(result);
  }
  // Site tz + contact card + staff_name (E-4) resolved together for the one row.
  const appointment = await projectSingleAppointment(auth.auth, result.value, labels);
  return Response.json({ appointment }, { status: result.deduped ? 200 : 201 });
}
