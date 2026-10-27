"use server";

import { revalidatePath } from "next/cache";
import { gateClientModule } from "./clientModuleAccess";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { isUuid } from "./clientModuleValidation";
import { createThenMaybeConfirm, type CreateOutcome, type ManualBookingResult } from "./manualBooking";
import { can, canAccessSchedulingSite, canAccessSchedulingStaff, isSchedulingStaff } from "./access";
import { listContacts } from "@worker/db/repositories/contacts.js";
import { findContactMatchesByIdentity } from "@worker/db/repositories/contactIdentities.js";
import { getSiteById } from "@worker/db/repositories/scheduling/sites.js";
import { validateGuest, maskIdentity, type ContactMatch, type ContactMode, type GuestValue } from "./walkInContact";
import { getAppointmentById, listAppointmentEvents, listAppointments } from "@worker/db/repositories/scheduling/appointments.js";
import { ensureReviewRequest } from "@worker/db/repositories/scheduling/reviews.js";
import { reviewLinkSecret, reviewPath, signReviewToken } from "./reviewLink";
import {
  blocksPastAttendance,
  createAppointment,
  changeAppointmentService,
  correctAppointmentTime,
  planPastAttendance,
  rescheduleAppointment,
  transitionStatus,
  type BookingError,
} from "@worker/scheduling/booking.js";
import { siteDayKey } from "./siteCalendar";
import type { PastConflict, PastProblemView } from "./pastAttendance";

/**
 * Server actions for the client-scoped Agenda (Phase 3A). Every action takes the
 * CONTEXTUAL clientId and is gated by the central module resolver (UUID →
 * session → canAccessClient → client-in-tenant → non-default → `scheduling`
 * enabled). The booking domain service then receives scopeClientId = the
 * VALIDATED client id — ALWAYS, also for owner/admin — so an action opened from
 * client A can never operate on a site or appointment of client B (the domain
 * treats the mismatch as not-found). Errors stay generic.
 */

export type ActionResult = { ok: true } | { ok: false; error: string; /** The engine's code (e.g. conflict_slot) when known. */ code?: string };

const GENERIC_GATE = "No disponible.";

/** Spanish copy for a booking-engine error — the agenda is a Spanish surface, so an
 * English "No se pudo cancelar la cita." no longer reaches the operator. */
function messageFor(error: BookingError, fallback: string): string {
  switch (error) {
    case "conflict_slot":
      return "Ese horario se acaba de ocupar. Elige otro.";
    case "unavailable":
      return "Ese horario no está disponible.";
    case "no_staff":
      return "Ese profesional no puede tomar ese horario.";
    case "not_found":
      return "No disponible.";
    case "module_disabled":
      // A concurrent disable — generic, no internal detail leaked.
      return "No disponible.";
    case "invalid_transition":
      return "Ese cambio de estado no está permitido.";
    case "contact_conflict":
      return "Ese teléfono o correo ya pertenece a otro contacto.";
    case "invalid_phone":
      return "No pudimos leer el teléfono. Escríbelo con el indicativo del país.";
    case "not_started":
      return "Se puede completar cuando la cita empiece.";
    case "not_immediate":
      return "Ese horario ya no es «ahora». Elige el siguiente horario disponible.";
    case "not_past":
      return "Solo se registran como realizadas las atenciones que ya terminaron. Revisa la fecha y la hora de inicio.";
    case "past_overlap":
      return "Ese horario se cruza con otra cita de ese profesional. No se cambió ninguna cita.";
    default:
      return fallback;
  }
}

/** Shared gate: resolve the scheduling module context or fail generically. */
/** Shared gate: the scheduling module + the named permission (agenda.view for reads,
 *  agenda.book for writes), or the error to return (NO_PERMISSION when revoked). */
async function gate(clientId: string, permission: "agenda.view" | "agenda.book") {
  return gateClientModule(clientId, "scheduling", permission, GENERIC_GATE);
}

async function gateAppointment(clientId: string, appointmentId: string, permission: "agenda.view" | "agenda.book") {
  const g = await gate(clientId, permission);
  if (!g.ok) return g;
  const ctx = g.context;
  const appointment = await getAppointmentById(ctx.scope.tenantId, appointmentId);
  if (
    !appointment ||
    appointment.client_id !== ctx.client.id ||
    !canAccessSchedulingSite(ctx.scope, appointment.site_id) ||
    // A staff login may act only on its OWN column — cancel/confirm/complete/no-show/
    // reschedule of another staff member's appointment is refused here.
    !canAccessSchedulingStaff(ctx.scope, appointment.staff_id)
  ) {
    return { ok: false as const, error: GENERIC_GATE };
  }
  return { ok: true as const, ctx, appointment };
}

function agendaPath(clientId: string): string {
  return `/clients/${clientId}/scheduling/agenda`;
}

/**
 * One row of the booking modal's customer search. A deliberately NARROW projection of
 * ContactListItem: the modal needs to tell two people named "Lucía" apart and to warn
 * about a duplicate booking, and nothing else. Everything here is stored or computed in
 * SQL by listContacts — none of it is inferred in the UI.
 */
export interface ContactSearchHit {
  id: string;
  name: string | null;
  /** Phone-or-email. NULL for a staff-scoped login, which must not see identities. */
  identity: string | null;
  /** Both, for the reference's two-line recents (same masking as `identity`). */
  phone: string | null;
  email: string | null;
  /** ≥1 completed appointment — the "Ya es cliente" chip. */
  isCustomer: boolean;
  appointmentCount: number;
  /** Last COMPLETED appointment already in the past. */
  lastVisitAt: string | null;
  /** Their next appointment, if any — powers the "possible duplicate" warning. */
  nextAppointmentAt: string | null;
}

/**
 * Search this CLIENT's contacts for the booking modal.
 *
 * Scoped twice over: the module gate resolves the validated client, and `clientId` is
 * then passed to listContacts so the query itself is client-filtered — a tenant with
 * two shops can never surface the other shop's customers here. Identities are withheld
 * from staff-scoped logins, matching the agenda page's own rule for primary_identity.
 */
export async function searchSchedulingContactsAction(
  clientId: string,
  search: string,
): Promise<{ ok: true; hits: ContactSearchHit[] } | { ok: false; error: string }> {
  const term = search.trim();
  // Below two characters every contact matches, which is a table scan rendered as a
  // useless list. The caller shows its "keep typing" hint instead.
  if (term.length < 2) {
    const g = await gate(clientId, "agenda.book");
    return g.ok ? { ok: true, hits: [] } : { ok: false, error: g.error };
  }
  return contactHits(clientId, { search: term, limit: 8 });
}

/** «Recientes» (Nueva cita, reference E4): the client's contacts with the latest activity
 *  — the SAME gate, CRM check and identity masking as the search. */
export async function recentSchedulingContactsAction(
  clientId: string,
): Promise<{ ok: true; hits: ContactSearchHit[] } | { ok: false; error: string }> {
  return contactHits(clientId, { limit: 3 });
}

async function contactHits(
  clientId: string,
  q: { search?: string; limit: number },
): Promise<{ ok: true; hits: ContactSearchHit[] } | { ok: false; error: string }> {
  const g = await gate(clientId, "agenda.book");
  if (!g.ok) return { ok: false, error: g.error };
  const ctx = g.context;
  // The customers searched here are CRM contacts: without the CRM module there is
  // nothing to search (a professional login used to reach them regardless).
  if (!(await isClientModuleEnabled(ctx.scope.tenantId, ctx.client.id, "crm"))) return { ok: true, hits: [] };
  const { items } = await listContacts(ctx.scope.tenantId, {
    ...(q.search ? { search: q.search } : {}),
    clientId: ctx.client.id,
    limit: q.limit,
  });
  // Names suffice to book; phone/email only for a login that may see contacts (never a
  // professional login, which stays narrower than its permissions on the agenda).
  const hideIdentity = isSchedulingStaff(ctx.scope) || !can(ctx.scope, "contacts.view", ctx.client.id);
  return {
    ok: true,
    hits: items.map((c) => ({
      id: c.id,
      name: c.name,
      identity: hideIdentity ? null : c.phone_e164 ?? c.email ?? null,
      phone: hideIdentity ? null : c.phone_e164 ?? null,
      email: hideIdentity ? null : c.email ?? null,
      isCustomer: c.is_customer,
      appointmentCount: c.appointment_count,
      lastVisitAt: c.last_visit_at ? c.last_visit_at.toISOString() : null,
      nextAppointmentAt: c.next_appointment_at ? c.next_appointment_at.toISOString() : null,
    })),
  };
}

export interface ManualAppointmentInput {
  siteId: string;
  serviceId: string;
  staffId?: string | null;
  startAt: string; // ISO
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  channel?: string;
  channelUserId?: string;
  walkIn?: boolean;
  /** C-4.1: book for an EXISTING contact (e.g. from the contact record) — attaches to it
   *  without creating/mutating a contact. Wins over typed identity; the domain refuses a
   *  contact_id that isn't this client's, or typed identity that resolves elsewhere. */
  contactId?: string;
  /** One per open booking form (a UUID): a retried submit replays instead of booking
   *  twice — the engine's idempotency, namespaced so it can't collide with API keys. */
  idempotencyKey?: string;
  /** "Estado inicial": `confirmed` runs the real confirm transition after creating. */
  initialStatus?: "scheduled" | "confirmed";
  /**
   * What to do with the typed name/phone/email (web/lib/walkInContact.ts):
   *   guest  — register WITHOUT a contact; what was typed stays on the appointment.
   *   create — save a contact (needs a valid phone or email; an existing match is offered
   *            to link instead — nothing is duplicated).
   * Omitted keeps the earlier rule for a typed phone (resolve the contact by that phone);
   * a NAME alone is always a guest — it never keys a contact.
   */
  contactMode?: Exclude<ContactMode, "link">;
  /**
   * «Atención sin cita · ahora» (walkIn only): the ONE exception to the site's minimum
   * notice, for someone already here — src/scheduling/immediate.ts. Only a login with
   * agenda.book on this site/column reaches it (the gate above); the start must be inside
   * the immediate window, and every other availability rule is still checked by the engine.
   */
  immediate?: boolean;
  /**
   * «Registrar atención realizada» (walkIn only, never with `immediate`): reception recording a
   * service that ALREADY happened — today or an earlier day, at its real start (any minute).
   * The engine checks that exact interval (src/scheduling/booking.ts · planPastAttendance) and
   * refuses it, with the reason, unless it ended before now and fits the professional's hours,
   * breaks and blocks that day without overlapping an active or completed appointment of theirs
   * (a no-show does not block). It is created AND completed in one engine transaction (the same
   * status write and audit event as «Completar»): saved as completed, with the real creation
   * date and who registered it; the payment stays pending; nothing is sent to anyone.
   */
  alreadyDone?: boolean;
}

/** Contacts that already carry this phone or email (read-only — never creates). */
async function contactMatches(
  tenantId: string,
  clientId: string,
  v: GuestValue,
  revealIdentity: boolean,
): Promise<ContactMatch[]> {
  const out: ContactMatch[] = [];
  const seen = new Set<string>();
  for (const [kind, value] of [["phone", v.phone], ["email", v.email]] as const) {
    if (!value) continue;
    const { matches } = await findContactMatchesByIdentity(tenantId, clientId, value, { limit: 3 });
    for (const m of matches) {
      if (seen.has(m.contact_id)) continue;
      seen.add(m.contact_id);
      out.push({
        contactId: m.contact_id,
        name: m.name,
        matchedBy: kind,
        matchedValue: revealIdentity ? m.matched_value : maskIdentity(kind, value),
      });
    }
  }
  return out;
}

/** Create a manual appointment or walk-in from the agenda. A walk-in without any
 * channel identity produces an appointment with no contact (contact_id null). */
export async function createManualAppointmentAction(
  clientId: string,
  input: ManualAppointmentInput,
): Promise<ManualBookingResult> {
  if (
    !isUuid(input.siteId) ||
    !isUuid(input.serviceId) ||
    (input.staffId && !isUuid(input.staffId)) ||
    (input.contactId && !isUuid(input.contactId)) ||
    (input.idempotencyKey && !isUuid(input.idempotencyKey)) ||
    (input.initialStatus && input.initialStatus !== "scheduled" && input.initialStatus !== "confirmed") ||
    // «Ya se realizó» is a walk-in only, and never «ahora» nor a chosen initial state.
    (input.alreadyDone && (!input.walkIn || input.immediate || input.initialStatus))
  ) {
    return { ok: false, error: GENERIC_GATE };
  }
  const g = await gate(clientId, "agenda.book");
  if (!g.ok) return { ok: false, error: g.error };
  const ctx = g.context;
  if (!canAccessSchedulingSite(ctx.scope, input.siteId)) {
    return { ok: false, error: GENERIC_GATE };
  }
  // A staff login books ONLY into its own column: an explicit other-staff id is refused,
  // and an omitted ("any") id is pinned to their own resource. Everyone else may pass a
  // staff id (or null for "any", resolved by the booking domain).
  let staffId = input.staffId ?? null;
  if (isSchedulingStaff(ctx.scope)) {
    if (staffId && !canAccessSchedulingStaff(ctx.scope, staffId)) return { ok: false, error: GENERIC_GATE };
    staffId = ctx.scope.schedulingStaffId;
  }
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "La hora de inicio no es válida." };
  // A service that already happened was done by SOMEONE: «cualquiera» is not a record.
  if (input.alreadyDone && !staffId) return { ok: false, error: "Elige quién realizó la atención." };

  // C-4.1: booking for an existing contact attaches to it directly (no typed identity).
  const bookingForContact = Boolean(input.contactId);
  const channel = input.channel ?? (input.walkIn ? "walk_in" : "manual");
  let guest: GuestValue | null = null;
  let channelUserId: string | undefined;
  let customerPhone: string | null = null;
  let customerEmail: string | null = null;
  if (!bookingForContact) {
    const site = await getSiteById(ctx.scope.tenantId, input.siteId);
    if (!site || site.client_id !== ctx.client.id) return { ok: false, error: GENERIC_GATE };
    const mode = input.contactMode ?? (input.customerPhone?.trim() || input.channelUserId ? "create" : "guest");
    const typed = validateGuest(
      { name: input.customerName, phone: input.customerPhone, email: input.customerEmail },
      { timeZone: site.timezone, requireIdentity: mode === "create" && !input.channelUserId },
    );
    if (!typed.ok) return { ok: false, error: "Revisa los datos del cliente.", fieldErrors: typed.fieldErrors };
    if (mode === "create") {
      // Explicit "Guardar contacto": an existing contact with this phone/email is OFFERED
      // to link — never duplicated, never silently merged under a new name.
      if (input.contactMode === "create") {
        const reveal = !isSchedulingStaff(ctx.scope) && can(ctx.scope, "contacts.view", ctx.client.id);
        const matches = await contactMatches(ctx.scope.tenantId, ctx.client.id, typed.value, reveal);
        if (matches.length > 0) {
          return { ok: false, error: "Ya existe un contacto con ese teléfono o correo. Vincúlalo en lugar de crear otro.", matches };
        }
      }
      customerPhone = typed.value.phone;
      customerEmail = typed.value.email;
      channelUserId = input.channelUserId ?? typed.value.phone ?? typed.value.email ?? undefined;
    } else {
      guest = typed.value.name || typed.value.phone || typed.value.email ? typed.value : null;
    }
  }

  const create = async (): Promise<CreateOutcome> => {
  const result = await createAppointment({
    tenantId: ctx.scope.tenantId,
    siteId: input.siteId,
    serviceId: input.serviceId,
    staffId,
    startAt: start,
    contactId: input.contactId ?? null,
    channel: channelUserId ? channel : null,
    channelUserId: channelUserId || null,
    customerName: bookingForContact || guest ? null : input.customerName?.trim() || null,
    customerPhone,
    customerEmail,
    guest,
    origin: input.walkIn ? "walk_in" : "internal",
    immediateWalkIn: Boolean(input.walkIn && input.immediate),
    pastWalkIn: Boolean(input.walkIn && input.alreadyDone),
    createdByType: "agent",
    createdByUserId: ctx.scope.userId,
    idempotencyKey: input.idempotencyKey ? `agenda-manual:${input.idempotencyKey}` : null,
    // The VALIDATED contextual client — a site of another client is not-found.
    scopeClientId: ctx.client.id,
  });
  if (!result.ok) {
    if (input.alreadyDone && result.problems?.length) {
      // The form names each rule (pausa 13:00–14:00, bloqueo…); nothing was written.
      return {
        ok: false,
        error: result.error === "not_past" ? messageFor("not_past", "") : "Ese profesional no estaba disponible a esa hora. No se cambió ninguna cita.",
        problems: result.problems.map((p) => ({ code: p.code, from: p.from.toISOString(), until: p.until.toISOString() })),
      };
    }
    if (input.alreadyDone && result.error === "no_staff") return { ok: false, error: "Ese profesional no tiene este servicio asignado en esta sede." };
    return { ok: false, error: messageFor(result.error, "No se pudo crear la cita.") };
  }
  return { ok: true, id: result.value.id, status: result.value.status };
  };

  const done = Boolean(input.walkIn && input.alreadyDone);
  // A walk-in that already happened is created AND completed by the engine in ONE
  // transaction (pastWalkIn) — there is no second step that could leave it half-registered.
  const outcome = await createThenMaybeConfirm(
    create,
    // The SAME gated transition the detail's "Confirmar" runs (own-column rule included).
    (id) => transition("confirmed", clientId, id, "No se pudo confirmar la cita."),
    done ? "scheduled" : input.initialStatus ?? "scheduled",
  );
  if (outcome.ok && done) {
    // Defence in depth: the engine committed it completed; anything else is reported, not hidden.
    const row = await getAppointmentById(ctx.scope.tenantId, outcome.id);
    if (row?.status !== "completed") return { ok: false, error: "No se pudo registrar la atención como completada." };
  }
  if (!outcome.ok && done && outcome.error === messageFor("past_overlap", "")) {
    // Show what it overlaps (the professional's own appointments, already visible in this
    // login's agenda) — the SAME interval the engine checked; nothing was changed.
    const past = await planPastAttendance({ tenantId: ctx.scope.tenantId, siteId: input.siteId, serviceId: input.serviceId, staffId, startAt: start, now: new Date() });
    if (past.ok) return { ...outcome, conflicts: past.plan.overlapping.filter((a) => blocksPastAttendance(a.status)).map((a) => pastConflict(a, past.plan.timezone)) };
  }
  if (outcome.ok) revalidatePath(agendaPath(ctx.client.id));
  return outcome;
}

function pastConflict(a: { id: string; start_at: Date; service_end_at: Date; status: string; service_name: string; customer_name: string | null }, timeZone: string): PastConflict {
  return {
    id: a.id,
    startAt: a.start_at.toISOString(),
    endAt: a.service_end_at.toISOString(),
    service: a.service_name,
    status: a.status,
    customer: a.customer_name,
    dayKey: siteDayKey(a.start_at, timeZone),
  };
}

export type PastAttendanceCheck =
  | {
      ok: true;
      /** The professional's own duration for this service, and the end it gives. */
      durationMin: number;
      serviceEndAt: string;
      /** Schedule rules the exact interval runs into (empty = it fits). */
      problems: PastProblemView[];
      /** Active or completed appointments of the professional it overlaps — they block. */
      conflicts: PastConflict[];
      /** No-shows it overlaps — they do NOT block (someone else was attended instead). */
      noShows: PastConflict[];
      /** The linked contact's still-open appointments that day with ANOTHER professional:
       *  maybe the visit already has its appointment («revísala en vez de duplicarla»). */
      sameClient: Array<PastConflict & { staffName: string | null }>;
    }
  | { ok: false; error: string };

/**
 * «Registrar atención realizada» — the read-only check the form runs BEFORE it offers to
 * confirm: the same plan the engine writes with (planPastAttendance), so what the form shows
 * and what the server accepts never disagree. The same gate as registering (agenda.book, the
 * site, a staff login only its own column); it writes nothing.
 */
export async function checkPastAttendanceAction(
  clientId: string,
  input: { siteId: string; serviceId: string; staffId: string; startAt: string; contactId?: string | null },
): Promise<PastAttendanceCheck> {
  if (!isUuid(input.siteId) || !isUuid(input.serviceId) || !isUuid(input.staffId) || (input.contactId && !isUuid(input.contactId))) {
    return { ok: false, error: GENERIC_GATE };
  }
  const g = await gate(clientId, "agenda.book");
  if (!g.ok) return { ok: false, error: g.error };
  const ctx = g.context;
  if (!canAccessSchedulingSite(ctx.scope, input.siteId)) return { ok: false, error: GENERIC_GATE };
  if (isSchedulingStaff(ctx.scope) && !canAccessSchedulingStaff(ctx.scope, input.staffId)) return { ok: false, error: GENERIC_GATE };
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "La hora de inicio no es válida." };
  const site = await getSiteById(ctx.scope.tenantId, input.siteId);
  if (!site || site.client_id !== ctx.client.id) return { ok: false, error: GENERIC_GATE };
  const past = await planPastAttendance({ tenantId: ctx.scope.tenantId, siteId: input.siteId, serviceId: input.serviceId, staffId: input.staffId, startAt: start, now: new Date() });
  if (!past.ok) return { ok: false, error: past.error === "no_staff" ? "Ese profesional no tiene este servicio asignado en esta sede." : GENERIC_GATE };
  const { plan } = past;
  let sameClient: Array<PastConflict & { staffName: string | null }> = [];
  // Another professional's column is not this login's to read when it is a staff login.
  if (input.contactId && !isSchedulingStaff(ctx.scope)) {
    const day = siteDayKey(start, plan.timezone);
    const rows = await listAppointments(ctx.scope.tenantId, {
      clientId: ctx.client.id,
      siteId: input.siteId,
      contactId: input.contactId,
      status: ["scheduled", "confirmed"],
      from: new Date(start.getTime() - 24 * 3_600_000),
      to: new Date(start.getTime() + 24 * 3_600_000),
    });
    sameClient = rows
      .filter((a) => a.staff_id !== plan.staffId && siteDayKey(a.start_at, plan.timezone) === day)
      .map((a) => ({ ...pastConflict({ ...a, service_name: a.service_name_snapshot, customer_name: a.contact_name }, plan.timezone), staffName: a.staff_name }));
  }
  return {
    ok: true,
    durationMin: plan.durationMin,
    serviceEndAt: plan.serviceEnd.toISOString(),
    problems: plan.problems.map((p) => ({ code: p.code, from: p.from.toISOString(), until: p.until.toISOString() })),
    conflicts: plan.overlapping.filter((a) => blocksPastAttendance(a.status)).map((a) => pastConflict(a, plan.timezone)),
    noShows: plan.overlapping.filter((a) => !blocksPastAttendance(a.status)).map((a) => pastConflict(a, plan.timezone)),
    sameClient,
  };
}

async function transition(
  target: "cancelled" | "confirmed" | "completed" | "no_show",
  clientId: string,
  appointmentId: string,
  fallback: string,
  reason?: string,
): Promise<ActionResult> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId, "agenda.book");
  if (!gated.ok) return { ok: false, error: gated.error };
  const { ctx } = gated;
  const r = await transitionStatus(target, {
    tenantId: ctx.scope.tenantId,
    appointmentId,
    actorType: "agent",
    actorUserId: ctx.scope.userId,
    reason: reason ?? null,
    scopeClientId: ctx.client.id, // always — cross-client appointment = not-found
    // Completar only once the appointment has started — the SAME rule on every screen.
    requireStartedToComplete: true,
  });
  if (!r.ok) return { ok: false, error: messageFor(r.error, fallback) };
  revalidatePath(agendaPath(ctx.client.id));
  return { ok: true };
}

export async function cancelAppointmentAction(clientId: string, appointmentId: string, reason?: string): Promise<ActionResult> {
  return transition("cancelled", clientId, appointmentId, "No se pudo cancelar la cita.", reason);
}

export async function confirmAppointmentAction(clientId: string, appointmentId: string): Promise<ActionResult> {
  return transition("confirmed", clientId, appointmentId, "No se pudo confirmar la cita.");
}

export async function completeAppointmentAction(clientId: string, appointmentId: string): Promise<ActionResult> {
  return transition("completed", clientId, appointmentId, "No se pudo completar la cita.");
}

export async function noShowAppointmentAction(clientId: string, appointmentId: string): Promise<ActionResult> {
  return transition("no_show", clientId, appointmentId, "No se pudo marcar la inasistencia.");
}

export async function rescheduleAppointmentAction(
  clientId: string,
  appointmentId: string,
  startAt: string,
  staffId?: string | null,
  /** The time and professional the operator SAW ("Antes"): if the appointment moved in
   *  the meantime nothing is written and the operator is told to review it. */
  expected?: { startAt: string; staffId: string } | null,
): Promise<ActionResult> {
  if (!isUuid(appointmentId) || (staffId && !isUuid(staffId)) || (expected && !isUuid(expected.staffId))) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId, "agenda.book");
  if (!gated.ok) return { ok: false, error: gated.error };
  const { ctx, appointment } = gated;
  // A staff login can't move the appointment to ANOTHER staff member's column.
  if (isSchedulingStaff(ctx.scope) && staffId && !canAccessSchedulingStaff(ctx.scope, staffId)) {
    return { ok: false, error: GENERIC_GATE };
  }
  const terminal = RESCHEDULE_TERMINAL[appointment.status];
  if (terminal) return { ok: false, error: terminal };
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "La hora de inicio no es válida." };
  const expectedStart = expected ? new Date(expected.startAt) : null;
  if (expectedStart && Number.isNaN(expectedStart.getTime())) return { ok: false, error: GENERIC_GATE };
  // Nothing effective to change: no write, no "reprogramada" entry in the history.
  if (start.getTime() === new Date(appointment.start_at).getTime() && (staffId ?? appointment.staff_id) === appointment.staff_id) {
    return { ok: false, error: "Elige una fecha, hora o profesional distintos a los actuales." };
  }
  const r = await rescheduleAppointment({
    tenantId: ctx.scope.tenantId,
    appointmentId,
    startAt: start,
    staffId: staffId ?? null,
    actorType: "agent",
    actorUserId: ctx.scope.userId,
    scopeClientId: ctx.client.id,
    expected: expected && expectedStart ? { startAt: expectedStart, staffId: expected.staffId } : null,
  });
  if (!r.ok) return { ok: false, error: RESCHEDULE_ERROR[r.error] ?? messageFor(r.error, "No se pudo reprogramar la cita."), code: r.error };
  revalidatePath(agendaPath(ctx.client.id));
  return { ok: true };
}

/** A reschedule's refusals, in the words the operator acts on. */
const RESCHEDULE_ERROR: Partial<Record<string, string>> = {
  unavailable: "Ese horario ya no está disponible. Elige otro.",
  conflict_slot: "Alguien acaba de ocupar ese horario. Elige otro.",
  no_staff: "Ese profesional no puede atender este servicio en ese horario.",
  stale: "La cita cambió mientras la editabas. Ciérrala y vuelve a abrirla para ver su horario actual.",
  invalid_transition: "Esta cita ya no se puede cambiar de fecha.",
};
const RESCHEDULE_TERMINAL: Partial<Record<string, string>> = {
  cancelled: "Esta cita está cancelada: ya no se puede cambiar su fecha.",
  completed: "Esta cita ya se completó: no se puede cambiar su fecha.",
  no_show: "Esta cita quedó como inasistencia: no se puede cambiar su fecha.",
};

// ── JP-4: edit an existing appointment (service change + time/staff correction) ──────────────
/** JP-4 refusals, in the operator's words. */
const EDIT_ERROR: Partial<Record<string, string>> = {
  unavailable: "El cambio se cruza con otra cita de este profesional. Ajusta o mueve la otra cita.",
  conflict_slot: "Alguien acaba de ocupar ese horario. Elige otro.",
  invalid_transition: "Esta cita ya no se puede editar así.",
  service_not_performed: "El profesional asignado no realiza ese servicio.",
  payment_recorded: "Esta cita tiene un cobro registrado. Anula el cobro, haz el cambio y vuelve a cobrar.",
  module_disabled: "La agenda está desactivada para este negocio.",
  not_found: GENERIC_GATE,
};

/**
 * JP-4 A1 — change an appointment's service. agenda.book (agency / Client Owner / Setter; a Staff
 * login on its own column). A Staff login may NOT change the service of a COMPLETED appointment (D3);
 * a completed appointment with a recorded payment is refused by the engine (void → re-charge, D1).
 */
export async function changeAppointmentServiceAction(
  clientId: string,
  appointmentId: string,
  newServiceId: string,
): Promise<ActionResult> {
  if (!isUuid(appointmentId) || !isUuid(newServiceId)) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId, "agenda.book");
  if (!gated.ok) return { ok: false, error: gated.error };
  const { ctx, appointment } = gated;
  if (appointment.status === "completed" && isSchedulingStaff(ctx.scope)) {
    return { ok: false, error: "Una cuenta de profesional no puede cambiar el servicio de una cita completada." };
  }
  const r = await changeAppointmentService({
    tenantId: ctx.scope.tenantId,
    appointmentId,
    newServiceId,
    scopeClientId: ctx.client.id,
    actorType: "agent",
    actorUserId: ctx.scope.userId,
  });
  if (!r.ok) return { ok: false, error: EDIT_ERROR[r.error] ?? messageFor(r.error, "No se pudo cambiar el servicio."), code: r.error };
  revalidatePath(agendaPath(ctx.client.id));
  return { ok: true };
}

/**
 * JP-4 B — correct the time (and optionally the artist) of an existing appointment, even a past or
 * completed one (a CORRECTION, not a reschedule). agenda.book — allowed for the Setter on completed
 * appointments too (D2); a Staff login can't move it to another professional's column. Changing the
 * artist on an appointment with a recorded payment is refused by the engine (void → re-charge, D5).
 */
export async function correctAppointmentTimeAction(
  clientId: string,
  appointmentId: string,
  startAt: string,
  staffId?: string | null,
  reason?: string | null,
): Promise<ActionResult> {
  if (!isUuid(appointmentId) || (staffId && !isUuid(staffId))) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId, "agenda.book");
  if (!gated.ok) return { ok: false, error: gated.error };
  const { ctx, appointment } = gated;
  if (isSchedulingStaff(ctx.scope) && staffId && !canAccessSchedulingStaff(ctx.scope, staffId)) {
    return { ok: false, error: GENERIC_GATE };
  }
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "La hora no es válida." };
  if (start.getTime() === new Date(appointment.start_at).getTime() && (staffId ?? appointment.staff_id) === appointment.staff_id) {
    return { ok: false, error: "Elige una hora o un profesional distintos a los actuales." };
  }
  const r = await correctAppointmentTime({
    tenantId: ctx.scope.tenantId,
    appointmentId,
    startAt: start,
    staffId: staffId ?? null,
    scopeClientId: ctx.client.id,
    actorType: "agent",
    actorUserId: ctx.scope.userId,
    reason: reason?.trim().slice(0, 500) || null,
  });
  if (!r.ok) return { ok: false, error: EDIT_ERROR[r.error] ?? messageFor(r.error, "No se pudo corregir la hora."), code: r.error };
  revalidatePath(agendaPath(ctx.client.id));
  return { ok: true };
}

/**
 * One row of an appointment's ACTIVITY ("Ver actividad" in the agenda detail) — a
 * read-only projection of `appointment_events`. Deliberately narrow: what happened,
 * who originated it (a role, never a user id) and when, plus the two details an
 * operator acts on (a reschedule's old/new time, a cancellation's typed reason).
 * Staff ids, user ids and the raw detail blob never leave the server.
 */
export interface AppointmentActivityItem {
  id: string;
  type: "created" | "rescheduled" | "service_changed" | "time_corrected" | "cancelled" | "confirmed" | "completed" | "no_show" | "note" | "other";
  actor: "team" | "public" | "agent" | "system";
  at: string;
  reason: string | null;
  fromStart: string | null;
  toStart: string | null;
  /** JP-4 service change: the service name before → after (names only; ids stay on the server). */
  fromService?: string | null;
  toService?: string | null;
}

const ACTIVITY_TYPE: Record<string, AppointmentActivityItem["type"]> = {
  appointment_created: "created",
  appointment_rescheduled: "rescheduled",
  appointment_service_changed: "service_changed",
  appointment_time_corrected: "time_corrected",
  appointment_cancelled: "cancelled",
  appointment_confirmed: "confirmed",
  appointment_completed: "completed",
  appointment_no_show: "no_show",
  manual_note: "note",
};
const ACTIVITY_ACTOR: Record<string, AppointmentActivityItem["actor"]> = {
  agent: "team",
  public: "public",
  n8n: "agent",
  system: "system",
};

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" && !(v instanceof Date)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * READ an appointment's activity. Same gate as every mutation here (gateAppointment):
 * the module context, the appointment belonging to THIS client and an allowed site,
 * and — for a staff login — their OWN column only. Changes nothing.
 */
export async function listAppointmentActivityAction(
  clientId: string,
  appointmentId: string,
): Promise<{ ok: true; items: AppointmentActivityItem[] } | { ok: false; error: string }> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId, "agenda.view");
  if (!gated.ok) return { ok: false, error: gated.error };
  const events = await listAppointmentEvents(gated.ctx.scope.tenantId, appointmentId);
  return {
    ok: true,
    items: events.map((e) => {
      const detail = (e.detail ?? {}) as Record<string, unknown>;
      const from = (detail.from && typeof detail.from === "object" ? detail.from : {}) as Record<string, unknown>;
      const to = (detail.to && typeof detail.to === "object" ? detail.to : {}) as Record<string, unknown>;
      const reason = typeof detail.reason === "string" && detail.reason.trim() ? detail.reason.trim().slice(0, 500) : null;
      // A reschedule AND a time correction both carry from/to start times.
      const moved = e.event_type === "appointment_rescheduled" || e.event_type === "appointment_time_corrected";
      const serviceChanged = e.event_type === "appointment_service_changed";
      const nameOrNull = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);
      return {
        id: e.id,
        type: ACTIVITY_TYPE[e.event_type] ?? "other",
        actor: ACTIVITY_ACTOR[e.actor_type] ?? "system",
        at: new Date(e.created_at).toISOString(),
        reason,
        fromStart: moved ? isoOrNull(from.start_at) : null,
        toStart: moved ? isoOrNull(to.start_at) : null,
        fromService: serviceChanged ? nameOrNull(from.name) : null,
        toService: serviceChanged ? nameOrNull(to.name) : null,
      };
    }),
  };
}

export type ReviewLinkResult =
  | { ok: true; path: string; answered: boolean; expiresAt: string }
  | { ok: false; error: string };

/**
 * The REVIEW LINK of a COMPLETED appointment ("Enlace de reseña"). Same gate as every
 * action here (gateAppointment) — so a staff login only gets links for its OWN column.
 * Idempotent: the first call creates the request, later calls return the same link.
 * Returns a PATH; the panel prefixes the browser's current origin (like bookingUrl).
 */
export async function getReviewLinkAction(clientId: string, appointmentId: string): Promise<ReviewLinkResult> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId, "agenda.view");
  if (!gated.ok) return { ok: false, error: gated.error };
  if (gated.appointment.status !== "completed") return { ok: false, error: "Solo las citas completadas pueden recibir reseña." };
  const secret = reviewLinkSecret();
  if (!secret) return { ok: false, error: "Los enlaces de reseña no están disponibles en este momento." };
  const req = await ensureReviewRequest(gated.ctx.scope.tenantId, gated.ctx.client.id, appointmentId);
  if (!req) return { ok: false, error: GENERIC_GATE };
  return {
    ok: true,
    path: reviewPath(signReviewToken(req.id, secret)),
    answered: req.status !== "requested",
    expiresAt: new Date(req.expires_at).toISOString(),
  };
}
