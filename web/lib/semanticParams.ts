import "server-only";
import { parseIsoDate, schedulingError, type SchedulingAuth } from "@/lib/schedulingApi";
import { isUuid } from "@/lib/clientModuleValidation";
import { combineLocalDayTime, parseClockTime, utcToZonedParts } from "@worker/scheduling/timezone.js";
import { isServiceEnabledAtSite, resolveServiceByNameAtSite } from "@worker/db/repositories/scheduling/services.js";
import { isActiveStaffOfSite, resolveStaffByNameAtSite, getStaffById } from "@worker/db/repositories/scheduling/staff.js";
import { findContactIdsByIdentity } from "@worker/db/repositories/contactIdentities.js";
import { resolveActiveAppointmentByLocalTime } from "@worker/db/repositories/scheduling/appointments.js";
import { loadAvailability } from "@worker/db/repositories/scheduling/availabilityData.js";
import { localStartFields, DEFAULT_LABEL_LOCALE } from "@/lib/localTime";
import { spreadNearest } from "@/lib/suggestTimes";

/**
 * SEMANTIC PARAMETERS — the values an LLM handles reliably (a service/staff NAME, a local
 * day + clock time, a phone) as an alternative to opaque UUIDs and ISO timestamps. Every
 * resolver runs server-side, AFTER the site is resolved as owned, and returns either the
 * canonical id/instant or a ready HTTP error whose message lets an agent recover in one
 * turn (valid names, candidates, nearest times). The id/ISO path is unchanged, so existing
 * programmatic callers keep working byte-identically.
 */

export type Resolved<T> = { ok: true; value: T } | { ok: false; response: Response };
const fail = (status: number, code: string, message: string): { ok: false; response: Response } => ({
  ok: false,
  response: schedulingError(status, code, message),
});
const has = (v: string | null | undefined): v is string => v != null && v.trim() !== "";

function serviceNotFound(name: string, valid: string[]): { ok: false; response: Response } {
  return fail(400, "service_not_found", `No service named “${name}” at this site. Valid services: ${valid.join(", ") || "(none configured)"}.`);
}
function staffNotFound(name: string, valid: string[]): { ok: false; response: Response } {
  return fail(400, "staff_not_found", `No staff named “${name}” at this site. Valid staff: ${valid.join(", ") || "(none configured)"}.`);
}

/** service_id OR service (name). Both + disagree → param_conflict. Neither → invalid_request. */
export async function resolveServiceParam(
  auth: SchedulingAuth,
  siteId: string,
  serviceId: string | null | undefined,
  serviceName: string | null | undefined,
): Promise<Resolved<string>> {
  const hasId = has(serviceId);
  const hasName = has(serviceName);
  if (!hasId && !hasName) return fail(400, "invalid_request", "Provide service_id or service (the service name).");
  let fromName: string | null = null;
  if (hasName) {
    const m = await resolveServiceByNameAtSite(auth.tenantId, siteId, serviceName);
    if (m.status === "not_found") return serviceNotFound(serviceName!.trim(), m.valid);
    if (m.status === "ambiguous") {
      return fail(400, "ambiguous_match", `More than one service matches “${serviceName!.trim()}”: ${m.candidates.map((c) => `${c.name} (${c.id})`).join("; ")}. Pass service_id to choose.`);
    }
    fromName = m.id;
  }
  if (hasId) {
    if (!isUuid(serviceId!)) return fail(400, "invalid_request", "service_id must be a valid UUID.");
    if (!(await isServiceEnabledAtSite(auth.tenantId, siteId, serviceId!))) {
      return fail(404, "service_not_found", "No service with that id is offered at this site. Call GET /api/scheduling/v1/services?site_id=… for valid ids.");
    }
    if (fromName && fromName !== serviceId) return fail(400, "param_conflict", "service_id and service refer to different services — send only one.");
    return { ok: true, value: serviceId! };
  }
  return { ok: true, value: fromName! };
}

/** staff_id OR staff (name), OPTIONAL. Neither → null ("any"). Both + disagree → param_conflict. */
export async function resolveStaffParam(
  auth: SchedulingAuth,
  siteId: string,
  staffId: string | null | undefined,
  staffName: string | null | undefined,
): Promise<Resolved<string | null>> {
  const hasId = has(staffId);
  const hasName = has(staffName);
  if (!hasId && !hasName) return { ok: true, value: null };
  let fromName: string | null = null;
  if (hasName) {
    const m = await resolveStaffByNameAtSite(auth.tenantId, siteId, staffName);
    if (m.status === "not_found") return staffNotFound(staffName!.trim(), m.valid);
    if (m.status === "ambiguous") {
      return fail(400, "ambiguous_match", `More than one staff member matches “${staffName!.trim()}”: ${m.candidates.map((c) => `${c.name} (${c.id})`).join("; ")}. Pass staff_id to choose.`);
    }
    fromName = m.id;
  }
  if (hasId) {
    if (!isUuid(staffId!)) return fail(400, "invalid_request", "staff_id must be a valid UUID.");
    if (!(await isActiveStaffOfSite(auth.tenantId, siteId, staffId!))) {
      return fail(404, "staff_not_found", "No active staff with that id at this site. Call GET /api/scheduling/v1/staff?site_id=… for valid ids.");
    }
    if (fromName && fromName !== staffId) return fail(400, "param_conflict", "staff_id and staff refer to different staff — send only one.");
    return { ok: true, value: staffId! };
  }
  return { ok: true, value: fromName };
}

/**
 * start_at (ISO-8601) OR day ("YYYY-MM-DD") + time (site-local clock). Both + disagree →
 * param_conflict. `tz` is the SITE timezone, so the caller never converts. Keeps the exact
 * 422 invalid_body messages an existing start_at caller already sees.
 */
export function resolveStartParam(
  startAt: string | null | undefined,
  day: string | null | undefined,
  time: string | null | undefined,
  tz: string,
): Resolved<Date> {
  const hasStart = has(startAt);
  const hasDay = has(day);
  const hasTime = has(time);
  if (!hasStart && !hasDay && !hasTime) {
    return fail(422, "invalid_body", "Provide start_at (ISO-8601) or day + time (site-local).");
  }
  let fromDayTime: Date | null = null;
  if (hasDay || hasTime) {
    if (!(hasDay && hasTime)) return fail(400, "invalid_request", "day and time must be provided together.");
    fromDayTime = combineLocalDayTime(day!, time!, tz);
    if (!fromDayTime) {
      return fail(400, "invalid_request", `Could not read day “${day}” + time “${time}”. Use day=YYYY-MM-DD and time as “14:30” (24h) or “9:00 am”.`);
    }
  }
  let fromStart: Date | null = null;
  if (hasStart) {
    fromStart = parseIsoDate(startAt);
    if (!fromStart) return fail(422, "invalid_body", "start_at must be an ISO-8601 datetime.");
  }
  if (fromStart && fromDayTime && fromStart.getTime() !== fromDayTime.getTime()) {
    return fail(400, "param_conflict", "start_at and day+time refer to different times — send only one.");
  }
  return { ok: true, value: (fromStart ?? fromDayTime)! };
}

/** The path segment that means "identify the appointment from the body, not by UUID". */
export const BY_TIME = "by-time";

/**
 * §3: resolve which appointment a cancel/reschedule targets. `pathId` is either a UUID
 * (existing callers, unchanged) or the literal `by-time`, in which case the body must carry
 * `phone`/`email`/`external_id` + `current_day` + `current_time` and we resolve that
 * contact's ACTIVE appointment at that local moment. A wrong id on cancel is the most
 * destructive transcription error, so this NEVER guesses: no match → 404 with the contact's
 * active appointments; more than one → 400 ambiguous_match.
 */
export async function resolveAppointmentTarget(
  auth: SchedulingAuth,
  pathId: string,
  identity: { phone?: string | null; email?: string | null; externalId?: string | null; currentDay?: string | null; currentTime?: string | null },
): Promise<Resolved<string>> {
  if (isUuid(pathId)) return { ok: true, value: pathId };
  if (pathId !== BY_TIME) {
    return fail(400, "invalid_request", `appointment id must be a valid UUID, or “${BY_TIME}” with phone/email/external_id + current_day + current_time.`);
  }
  if (!has(identity.phone) && !has(identity.email) && !has(identity.externalId)) {
    return fail(400, "invalid_request", "Provide phone, email, or external_id (with current_day + current_time) to identify the appointment by time.");
  }
  if (!has(identity.currentDay) || !has(identity.currentTime)) {
    return fail(400, "invalid_request", "current_day (YYYY-MM-DD) and current_time are required to find the appointment by time.");
  }
  const hhmm = parseClockTime(identity.currentTime);
  if (!hhmm) return fail(400, "invalid_request", `Could not read current_time “${identity.currentTime}”. Use “14:30” (24h) or “9:00 am”.`);
  const contactIds = await resolveContactIds(auth, identity);
  const m = await resolveActiveAppointmentByLocalTime(auth.tenantId, auth.clientId, contactIds, identity.currentDay!.trim(), hhmm);
  if (m.status === "ok") return { ok: true, value: m.id };
  // Read-aloud description of an active appointment: the SPOKEN date + time label (in the
  // appointment's OWN site tz), never the raw 24h string — an agent reads these back to a
  // customer. Uses the one shared label helper, so it matches every other spoken time.
  const describe = (x: { startAt: string; siteTimezone: string; service: string }): string => {
    const l = localStartFields(new Date(x.startAt), x.siteTimezone, DEFAULT_LABEL_LOCALE);
    return `${l.date_label} at ${l.start_label} — ${x.service}`;
  };
  if (m.status === "ambiguous") {
    return fail(400, "ambiguous_match", `More than one active appointment matches: ${m.matches.map((x) => `${describe(x)} (${x.id})`).join("; ")}. Pass the appointment id to choose.`);
  }
  const listing = m.active.length
    ? ` That contact's active appointments: ${m.active.map(describe).join("; ")}.`
    : " That contact has no active appointments.";
  return fail(404, "appointment_not_found", `No active appointment for that contact at ${identity.currentDay} ${identity.currentTime}.${listing}`);
}

/** Resolve phone/email/external_id → the client's contact-id set (may be empty). */
export async function resolveContactIds(
  auth: SchedulingAuth,
  identity: { phone?: string | null; email?: string | null; externalId?: string | null },
): Promise<string[]> {
  if (!has(identity.phone) && !has(identity.email) && !has(identity.externalId)) return [];
  return findContactIdsByIdentity({
    tenantId: auth.tenantId,
    clientId: auth.clientId,
    phone: identity.phone ?? undefined,
    email: identity.email ?? undefined,
    channelUserId: identity.externalId ?? undefined,
  });
}

/**
 * §2 recovery aid: when a requested day+time isn't bookable, suggest REAL alternatives from
 * the CANONICAL availability path (loadAvailability) for the SAME service, the SAME staff
 * filter (when one was given) and the SAME day — a strict subset of what GET /availability
 * returns, so the suggestion list can't drift from the source of truth (past / min-notice
 * times are already excluded by `now`). The times are spread across the day and nearest to
 * the requested time (see spreadNearest), rendered as spoken labels ("5:30 p. m."), and the
 * message NAMES the staff member when the request was for one — so an agent can never read a
 * time for the wrong person. Empty string on error (the caller appends this to its message).
 */
export async function nearestTimesHint(
  auth: SchedulingAuth,
  siteId: string,
  serviceId: string,
  staffId: string | null,
  around: Date,
  tz: string,
  locale: string = DEFAULT_LABEL_LOCALE,
): Promise<string> {
  try {
    const p = utcToZonedParts(around, tz);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const dayStart = combineLocalDayTime(`${p.year}-${pad(p.month)}-${pad(p.day)}`, "00:00", tz);
    if (!dayStart) return "";
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    const av = await loadAvailability({ tenantId: auth.tenantId, siteId, serviceId, staffId, from: dayStart, to: dayEnd, now: new Date() });

    // Whose availability is this? Name the requested staff member, so the suggestions can't be
    // read out against the wrong person; say "any staff" when no staff filter was in play.
    let withWhom = "";
    if (staffId) {
      const st = await getStaffById(auth.tenantId, staffId);
      withWhom = st?.name ? ` with ${st.name}` : "";
    }
    const scope = staffId ? `available${withWhom}` : "available (any staff)";

    if (!av || av.slots.length === 0) {
      return staffId
        ? ` No other times are ${scope} that day — offer another day, or another staff member.`
        : " No other times are available that day — offer another day.";
    }
    const labels = spreadNearest(
      av.slots.map((s) => s.start_at),
      around,
    ).map((d) => localStartFields(d, tz, locale).start_label);
    return ` Other times ${scope} that day: ${labels.join(", ")}.`;
  } catch {
    return "";
  }
}
