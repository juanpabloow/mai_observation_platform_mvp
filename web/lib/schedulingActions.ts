"use server";

import { revalidatePath } from "next/cache";
import { resolveClientModuleContext } from "./clientModuleAccess";
import { isUuid } from "./clientModuleValidation";
import { canAccessSchedulingSite, canOperateScheduling, isSchedulingStaff } from "./access";
import { listContacts } from "@worker/db/repositories/contacts.js";
import { getAppointmentById } from "@worker/db/repositories/scheduling/appointments.js";
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

const GENERIC_GATE = "Not available.";

function messageFor(error: BookingError, fallback: string): string {
  switch (error) {
    case "conflict_slot":
      return "That time was just booked. Pick another slot.";
    case "unavailable":
      return "That time is not available.";
    case "no_staff":
      return "The selected staff can't take that time.";
    case "not_found":
      return "Not available.";
    case "module_disabled":
      // A concurrent disable — generic, no internal detail leaked.
      return "Not available.";
    case "invalid_transition":
      return "That status change isn't allowed.";
    case "contact_conflict":
      return "That phone or email already belongs to a different contact.";
    default:
      return fallback;
  }
}

/** Shared gate: resolve the scheduling module context or fail generically. */
async function gate(clientId: string) {
  const resolved = await resolveClientModuleContext(clientId, "scheduling");
  if (!resolved.ok || !canOperateScheduling(resolved.context.scope)) return null;
  return resolved.context;
}

async function gateAppointment(clientId: string, appointmentId: string) {
  const ctx = await gate(clientId);
  if (!ctx) return null;
  const appointment = await getAppointmentById(ctx.scope.tenantId, appointmentId);
  if (
    !appointment ||
    appointment.client_id !== ctx.client.id ||
    !canAccessSchedulingSite(ctx.scope, appointment.site_id)
  ) {
    return null;
  }
  return { ctx, appointment };
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
  const ctx = await gate(clientId);
  if (!ctx) return { ok: false, error: GENERIC_GATE };
  const term = search.trim();
  // Below two characters every contact matches, which is a table scan rendered as a
  // useless list. The caller shows its "keep typing" hint instead.
  if (term.length < 2) return { ok: true, hits: [] };
  const { items } = await listContacts(ctx.scope.tenantId, {
    search: term,
    clientId: ctx.client.id,
    limit: 8,
  });
  const hideIdentity = isSchedulingStaff(ctx.scope);
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
}

/** Create a manual appointment or walk-in from the agenda. A walk-in without any
 * channel identity produces an appointment with no contact (contact_id null). */
export async function createManualAppointmentAction(
  clientId: string,
  input: ManualAppointmentInput,
): Promise<ActionResult> {
  if (!isUuid(input.siteId) || !isUuid(input.serviceId) || (input.staffId && !isUuid(input.staffId)) || (input.contactId && !isUuid(input.contactId))) {
    return { ok: false, error: GENERIC_GATE };
  }
  const ctx = await gate(clientId);
  if (!ctx) return { ok: false, error: GENERIC_GATE };
  if (!canAccessSchedulingSite(ctx.scope, input.siteId)) {
    return { ok: false, error: GENERIC_GATE };
  }
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid start time." };

  // C-4.1: booking for an existing contact attaches to it directly (no typed identity).
  // Otherwise a walk-in with a name+phone still resolves a contact (channel 'walk_in') so
  // it shows up in the CRM; a fully anonymous walk-in has no contact.
  const bookingForContact = Boolean(input.contactId);
  const hasIdentity = !bookingForContact && Boolean(input.channelUserId || input.customerPhone || input.customerName);
  const channel = input.channel ?? (input.walkIn ? "walk_in" : "manual");
  const channelUserId = hasIdentity
    ? input.channelUserId ?? (input.customerPhone || input.customerName || "").trim()
    : undefined;

  const result = await createAppointment({
    tenantId: ctx.scope.tenantId,
    siteId: input.siteId,
    serviceId: input.serviceId,
    staffId: input.staffId ?? null,
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
    idempotencyKey: null,
    // The VALIDATED contextual client — a site of another client is not-found.
    scopeClientId: ctx.client.id,
  });

  if (!result.ok) return { ok: false, error: messageFor(result.error, "Could not create the appointment.") };
  revalidatePath(agendaPath(ctx.client.id));
  return { ok: true };
}

async function transition(
  target: "cancelled" | "confirmed" | "completed" | "no_show",
  clientId: string,
  appointmentId: string,
  fallback: string,
  reason?: string,
): Promise<ActionResult> {
  if (!isUuid(appointmentId)) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId);
  if (!gated) return { ok: false, error: GENERIC_GATE };
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
  return transition("cancelled", clientId, appointmentId, "Could not cancel.", reason);
}

export async function confirmAppointmentAction(clientId: string, appointmentId: string): Promise<ActionResult> {
  return transition("confirmed", clientId, appointmentId, "Could not confirm.");
}

export async function completeAppointmentAction(clientId: string, appointmentId: string): Promise<ActionResult> {
  return transition("completed", clientId, appointmentId, "Could not complete.");
}

export async function noShowAppointmentAction(clientId: string, appointmentId: string): Promise<ActionResult> {
  return transition("no_show", clientId, appointmentId, "Could not mark no-show.");
}

export async function rescheduleAppointmentAction(
  clientId: string,
  appointmentId: string,
  startAt: string,
  staffId?: string | null,
): Promise<ActionResult> {
  if (!isUuid(appointmentId) || (staffId && !isUuid(staffId))) return { ok: false, error: GENERIC_GATE };
  const gated = await gateAppointment(clientId, appointmentId);
  if (!gated) return { ok: false, error: GENERIC_GATE };
  const { ctx } = gated;
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid start time." };
  const r = await rescheduleAppointment({
    tenantId: ctx.scope.tenantId,
    appointmentId,
    startAt: start,
    staffId: staffId ?? null,
    actorType: "agent",
    actorUserId: ctx.scope.userId,
    scopeClientId: ctx.client.id,
  });
  if (!r.ok) return { ok: false, error: messageFor(r.error, "Could not reschedule.") };
  revalidatePath(agendaPath(ctx.client.id));
  return { ok: true };
}
