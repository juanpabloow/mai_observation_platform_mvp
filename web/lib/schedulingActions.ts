"use server";

import { revalidatePath } from "next/cache";
import { gateClientModule } from "./clientModuleAccess";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";
import { isUuid } from "./clientModuleValidation";
import { createThenMaybeConfirm, type CreateOutcome, type ManualBookingResult } from "./manualBooking";
import { can, canAccessSchedulingSite, canAccessSchedulingStaff, isSchedulingStaff } from "./access";
import { listContacts } from "@worker/db/repositories/contacts.js";
import { getAppointmentById, listAppointmentEvents } from "@worker/db/repositories/scheduling/appointments.js";
import { ensureReviewRequest } from "@worker/db/repositories/scheduling/reviews.js";
import { reviewLinkSecret, reviewPath, signReviewToken } from "./reviewLink";
import {
  createAppointment,
  rescheduleAppointment,
  transitionStatus,
  type BookingError,
} from "@worker/scheduling/booking.js";

/**
 * Server actions for the client-scoped Agenda (Phase 3A). Every action takes the
 * CONTEXTUAL clientId and is gated by the central module resolver (UUID →
 * session → canAccessClient → client-in-tenant → non-default → `scheduling`
 * enabled). The booking domain service then receives scopeClientId = the
 * VALIDATED client id — ALWAYS, also for owner/admin — so an action opened from
 * client A can never operate on a site or appointment of client B (the domain
 * treats the mismatch as not-found). Errors stay generic.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

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
  const g = await gate(clientId, "agenda.book");
  if (!g.ok) return { ok: false, error: g.error };
  const ctx = g.context;
  // The customers searched here are CRM contacts: without the CRM module there is
  // nothing to search (a professional login used to reach them regardless).
  if (!(await isClientModuleEnabled(ctx.scope.tenantId, ctx.client.id, "crm"))) return { ok: true, hits: [] };
  const term = search.trim();
  // Below two characters every contact matches, which is a table scan rendered as a
  // useless list. The caller shows its "keep typing" hint instead.
  if (term.length < 2) return { ok: true, hits: [] };
  const { items } = await listContacts(ctx.scope.tenantId, {
    search: term,
    clientId: ctx.client.id,
    limit: 8,
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
    (input.initialStatus && input.initialStatus !== "scheduled" && input.initialStatus !== "confirmed")
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

  // C-4.1: booking for an existing contact attaches to it directly (no typed identity).
  // Otherwise a walk-in with a name+phone still resolves a contact (channel 'walk_in') so
  // it shows up in the CRM; a fully anonymous walk-in has no contact.
  const bookingForContact = Boolean(input.contactId);
  const hasIdentity = !bookingForContact && Boolean(input.channelUserId || input.customerPhone || input.customerName);
  const channel = input.channel ?? (input.walkIn ? "walk_in" : "manual");
  const channelUserId = hasIdentity
    ? input.channelUserId ?? (input.customerPhone || input.customerName || "").trim()
    : undefined;

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
    customerName: bookingForContact ? null : input.customerName ?? null,
    customerPhone: bookingForContact ? null : input.customerPhone ?? null,
    customerEmail: bookingForContact ? null : input.customerEmail ?? null,
    origin: input.walkIn ? "walk_in" : "internal",
    createdByType: "agent",
    createdByUserId: ctx.scope.userId,
    idempotencyKey: input.idempotencyKey ? `agenda-manual:${input.idempotencyKey}` : null,
    // The VALIDATED contextual client — a site of another client is not-found.
    scopeClientId: ctx.client.id,
  });
  if (!result.ok) return { ok: false, error: messageFor(result.error, "No se pudo crear la cita.") };
  return { ok: true, id: result.value.id, status: result.value.status };
  };

  const outcome = await createThenMaybeConfirm(
    create,
    // The SAME gated transition the detail's "Confirmar" runs (own-column rule included).
    (id) => transition("confirmed", clientId, id, "No se pudo confirmar la cita."),
    input.initialStatus ?? "scheduled",
  );
  if (outcome.ok) revalidatePath(agendaPath(ctx.client.id));
  return outcome;
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
  if (!r.ok) return { ok: false, error: RESCHEDULE_ERROR[r.error] ?? messageFor(r.error, "No se pudo reprogramar la cita.") };
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

/**
 * One row of an appointment's ACTIVITY ("Ver actividad" in the agenda detail) — a
 * read-only projection of `appointment_events`. Deliberately narrow: what happened,
 * who originated it (a role, never a user id) and when, plus the two details an
 * operator acts on (a reschedule's old/new time, a cancellation's typed reason).
 * Staff ids, user ids and the raw detail blob never leave the server.
 */
export interface AppointmentActivityItem {
  id: string;
  type: "created" | "rescheduled" | "cancelled" | "confirmed" | "completed" | "no_show" | "note" | "other";
  actor: "team" | "public" | "agent" | "system";
  at: string;
  reason: string | null;
  fromStart: string | null;
  toStart: string | null;
}

const ACTIVITY_TYPE: Record<string, AppointmentActivityItem["type"]> = {
  appointment_created: "created",
  appointment_rescheduled: "rescheduled",
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
      const moved = e.event_type === "appointment_rescheduled";
      return {
        id: e.id,
        type: ACTIVITY_TYPE[e.event_type] ?? "other",
        actor: ACTIVITY_ACTOR[e.actor_type] ?? "system",
        at: new Date(e.created_at).toISOString(),
        reason,
        fromStart: moved ? isoOrNull(from.start_at) : null,
        toStart: moved ? isoOrNull(to.start_at) : null,
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
