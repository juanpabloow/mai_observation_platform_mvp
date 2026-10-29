import type { ActorType, AppointmentRow, AppointmentStatus } from '../db/repositories/scheduling/appointments.js';
import { recordPipelineFailure } from './failures.js';
import { bookingActor, ensureOpportunityPaidForPayment, onAppointmentStatusChanged, onBookingCreated, openOnInbound, revertOpportunityPaid } from './engine.js';

/**
 * FAIL-SAFE pipeline hooks. Each wraps an engine operation in try/catch so a pipeline error NEVER
 * fails the underlying write (the inbound message is already stored; the booking/cancel/complete has
 * already committed). Failures are counted and healed by the auto-lost sweep / a later backfill.
 * These run AFTER the underlying commit, so they are the only pipeline code the hot paths await.
 */

/** Inbound message → open/reopen a sale. Call AFTER attribution (so an ad touch exists to read). */
export async function pipelineOnInboundMessage(input: { tenantId: string; clientId: string; contactId: string; conversationId: string | null; messageId: string }): Promise<void> {
  try {
    await openOnInbound(input);
  } catch (err) {
    recordPipelineFailure({ hook: 'inbound_message', clientId: input.clientId, contactId: input.contactId, messageId: input.messageId }, err);
  }
}

/** A booking committed → link + advance its sale. Call post-commit from the booking chokepoint. */
export async function pipelineOnBookingCreated(appt: AppointmentRow, actorType: ActorType, actorUserId: string | null): Promise<void> {
  try {
    await onBookingCreated(appt, bookingActor(actorType, actorUserId));
  } catch (err) {
    recordPipelineFailure({ hook: 'booking_created', clientId: appt.client_id, appointmentId: appt.id }, err);
  }
}

/** An appointment status changed → drive its sale. Call post-commit from the booking chokepoint. */
export async function pipelineOnAppointmentStatusChanged(appt: AppointmentRow, target: AppointmentStatus, actorType: ActorType, actorUserId: string | null): Promise<void> {
  try {
    await onAppointmentStatusChanged(appt, target, bookingActor(actorType, actorUserId));
  } catch (err) {
    recordPipelineFailure({ hook: 'appointment_status', clientId: appt.client_id, appointmentId: appt.id, target }, err);
  }
}

/** PY-1 / JP-6: a payment was recorded → its sale must end at `paid`. Fast-forwards the linked sale,
 *  or (when the appointment has none) advances the contact's open sale / creates one directly at paid
 *  and links it. Post-commit, fail-safe (never rolls back the payment). No contact → nothing to do. */
export async function pipelineOnPaymentRecorded(appt: AppointmentRow, actorUserId: string | null): Promise<void> {
  try {
    await ensureOpportunityPaidForPayment(appt, { kind: 'user', userId: actorUserId });
  } catch (err) {
    recordPipelineFailure({ hook: 'payment_recorded', clientId: appt.client_id, appointmentId: appt.id }, err);
  }
}

/** PY-1: a payment was voided → revert its sale paid → attended. Post-commit, fail-safe. */
export async function pipelineOnPaymentVoided(appt: AppointmentRow, actorUserId: string | null): Promise<void> {
  if (!appt.opportunity_id) return;
  try {
    await revertOpportunityPaid(appt.tenant_id, appt.client_id, appt.opportunity_id, { kind: 'user', userId: actorUserId });
  } catch (err) {
    recordPipelineFailure({ hook: 'payment_voided', clientId: appt.client_id, appointmentId: appt.id }, err);
  }
}
