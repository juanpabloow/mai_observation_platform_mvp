"use server";

import { revalidatePath } from "next/cache";
import { getAccessScope } from "./access";
import {
  createAppointment,
  rescheduleAppointment,
  transitionStatus,
  type BookingError,
} from "@worker/scheduling/booking.js";

/**
 * Server actions for the internal agenda. Access is resolved from the SESSION (never
 * the client): owner/admin act across ALL clients (scopeClientId = null), a member
 * is hard-scoped to their ONE client (scopeClientId = memberClientId) — the booking
 * domain service rejects any cross-client id as not-found. They delegate to the SAME
 * booking engine the n8n API and public page use, and revalidate the agenda.
 */

export type ActionResult = { ok: true } | { ok: false; error: string };

function messageFor(error: BookingError, fallback: string): string {
  switch (error) {
    case "conflict_slot":
      return "That time was just booked. Pick another slot.";
    case "unavailable":
      return "That time is not available.";
    case "no_staff":
      return "The selected staff can't take that time.";
    case "not_found":
      return "Service/site not found.";
    case "invalid_transition":
      return "That status change isn't allowed.";
    default:
      return fallback;
  }
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
}

/** Create a manual appointment or walk-in from the agenda. A walk-in without any
 * channel identity produces an appointment with no contact (contact_id null). */
export async function createManualAppointmentAction(input: ManualAppointmentInput): Promise<ActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const start = new Date(input.startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid start time." };

  // A walk-in with a name+phone still resolves a contact (channel 'walk_in') so it
  // shows up in the CRM; a fully anonymous walk-in has no contact.
  const hasIdentity = Boolean(input.channelUserId || input.customerPhone || input.customerName);
  const channel = input.channel ?? (input.walkIn ? "walk_in" : "manual");
  const channelUserId =
    input.channelUserId ?? (hasIdentity ? (input.customerPhone || input.customerName || "").trim() : undefined);

  const result = await createAppointment({
    tenantId,
    siteId: input.siteId,
    serviceId: input.serviceId,
    staffId: input.staffId ?? null,
    startAt: start,
    channel: channelUserId ? channel : null,
    channelUserId: channelUserId || null,
    customerName: input.customerName ?? null,
    customerPhone: input.customerPhone ?? null,
    customerEmail: input.customerEmail ?? null,
    origin: input.walkIn ? "walk_in" : "internal",
    createdByType: "agent",
    createdByUserId: scope.userId,
    idempotencyKey: null,
    scopeClientId: scope.memberClientId,
  });

  if (!result.ok) return { ok: false, error: messageFor(result.error, "Could not create the appointment.") };
  revalidatePath("/scheduling/agenda");
  return { ok: true };
}

export async function cancelAppointmentAction(appointmentId: string, reason?: string): Promise<ActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const r = await transitionStatus("cancelled", { tenantId, appointmentId, actorType: "agent", actorUserId: scope.userId, reason, scopeClientId: scope.memberClientId });
  if (!r.ok) return { ok: false, error: messageFor(r.error, "Could not cancel.") };
  revalidatePath("/scheduling/agenda");
  return { ok: true };
}

export async function confirmAppointmentAction(appointmentId: string): Promise<ActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const r = await transitionStatus("confirmed", { tenantId, appointmentId, actorType: "agent", actorUserId: scope.userId, scopeClientId: scope.memberClientId });
  if (!r.ok) return { ok: false, error: messageFor(r.error, "Could not confirm.") };
  revalidatePath("/scheduling/agenda");
  return { ok: true };
}

export async function completeAppointmentAction(appointmentId: string): Promise<ActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const r = await transitionStatus("completed", { tenantId, appointmentId, actorType: "agent", actorUserId: scope.userId, scopeClientId: scope.memberClientId });
  if (!r.ok) return { ok: false, error: messageFor(r.error, "Could not complete.") };
  revalidatePath("/scheduling/agenda");
  return { ok: true };
}

export async function noShowAppointmentAction(appointmentId: string): Promise<ActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const r = await transitionStatus("no_show", { tenantId, appointmentId, actorType: "agent", actorUserId: scope.userId, scopeClientId: scope.memberClientId });
  if (!r.ok) return { ok: false, error: messageFor(r.error, "Could not mark no-show.") };
  revalidatePath("/scheduling/agenda");
  return { ok: true };
}

export async function rescheduleAppointmentAction(
  appointmentId: string,
  startAt: string,
  staffId?: string | null,
): Promise<ActionResult> {
  const scope = await getAccessScope();
  const tenantId = scope.tenantId;
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) return { ok: false, error: "Invalid start time." };
  const r = await rescheduleAppointment({
    tenantId,
    appointmentId,
    startAt: start,
    staffId: staffId ?? null,
    actorType: "agent",
    actorUserId: scope.userId,
    scopeClientId: scope.memberClientId,
  });
  if (!r.ok) return { ok: false, error: messageFor(r.error, "Could not reschedule.") };
  revalidatePath("/scheduling/agenda");
  return { ok: true };
}
