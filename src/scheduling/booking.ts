import { isDeadlock, isExclusionViolation, isUniqueViolation, query, withTransaction } from '../db/client.js';
import { logger } from '../logger.js';
import { resolveOrCreateContact, linkConversationToContact } from '../db/repositories/contacts.js';
import { getOrCreateConversation } from '../db/repositories/handoff.js';
import {
  isSlotAvailable,
  loadAvailability,
  resolveEffectivePrice,
} from '../db/repositories/scheduling/availabilityData.js';
import {
  getAppointmentForUpdate,
  findByIdempotencyKey,
  insertAppointment,
  moveInterval,
  recordAppointmentEvent,
  setStatus,
  type AppointmentRow,
  type AppointmentStatus,
  type AppointmentOrigin,
  type ActorType,
} from '../db/repositories/scheduling/appointments.js';
import { recordSchedulingEvent } from '../db/repositories/scheduling/events.js';

/**
 * The booking domain service — the single engine BOTH n8n and the public page use.
 * All mutations run in one transaction (revalidate → insert/update → audit event),
 * rely on the appointments GiST exclusion constraint for the anti-double-book
 * guarantee (SQLSTATE 23P01 → a 'conflict_slot' result → the API's HTTP 409), and
 * emit the realtime scheduling_event ONLY AFTER the commit succeeds.
 */

const MS_PER_MIN = 60_000;

export type BookingError =
  | 'not_found' // site/service not bookable together
  | 'no_staff' // no qualified staff, or requested staff can't do it
  | 'unavailable' // slot not offered by the engine
  | 'conflict_slot' // lost the concurrency race (exclusion constraint)
  | 'conflict_idempotency' // same key, different payload
  | 'invalid_transition'; // illegal status change / reschedule from terminal

export type BookingResult<T> = { ok: true; value: T; deduped?: boolean } | { ok: false; error: BookingError; message: string };

export interface CreateAppointmentInput {
  tenantId: string;
  siteId: string;
  serviceId: string;
  staffId?: string | null; // null/undefined = "any"
  startAt: Date;
  // Identity (all optional — a walk-in may have none).
  workflowRef?: string | null;
  conversationRef?: string | null;
  channel?: string | null;
  channelUserId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  // Provenance.
  origin: AppointmentOrigin;
  createdByType: ActorType;
  createdByUserId?: string | null;
  idempotencyKey?: string | null;
  /** When set (a member), the site's client must equal this, else not_found. */
  scopeClientId?: string | null;
  now?: Date;
}

/** Structural idempotency comparison: same key + same (site, service, start, and
 * staff-if-specified) ⇒ the same booking (return it); otherwise it's a reuse with
 * a different payload ⇒ conflict. */
function samePayload(existing: AppointmentRow, input: CreateAppointmentInput): boolean {
  return (
    existing.site_id === input.siteId &&
    existing.service_id === input.serviceId &&
    existing.start_at.getTime() === input.startAt.getTime() &&
    (input.staffId == null || existing.staff_id === input.staffId)
  );
}

export async function createAppointment(
  input: CreateAppointmentInput,
): Promise<BookingResult<AppointmentRow>> {
  const now = input.now ?? new Date();

  // 1. Idempotency short-circuit (before any writes).
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (existing) {
      return samePayload(existing, input)
        ? { ok: true, value: existing, deduped: true }
        : { ok: false, error: 'conflict_idempotency', message: 'Idempotency-Key reused with a different payload.' };
    }
  }

  // 2. Resolve timing + choose a concrete staff via the availability engine.
  const avail = await loadAvailability({
    tenantId: input.tenantId,
    siteId: input.siteId,
    serviceId: input.serviceId,
    staffId: input.staffId ?? null,
    from: new Date(input.startAt.getTime() - 60 * MS_PER_MIN),
    to: new Date(input.startAt.getTime() + 60 * MS_PER_MIN),
    now,
  });
  if (!avail) return { ok: false, error: 'not_found', message: 'Service is not offered at this site.' };

  const slot = avail.slots.find((s) => s.start_at.getTime() === input.startAt.getTime());
  if (!slot) return { ok: false, error: 'unavailable', message: 'That time is no longer available.' };
  const chosenStaffId = input.staffId ?? slot.staff_id;
  const candidate = slot.candidates.find((c) => c.staff_id === chosenStaffId);
  if (!candidate) {
    return { ok: false, error: 'no_staff', message: 'The requested staff is not available for that time.' };
  }

  const clientId = avail.site.client_id;
  if (input.scopeClientId && clientId !== input.scopeClientId) {
    return { ok: false, error: 'not_found', message: 'Service is not offered at this site.' };
  }
  const priceSnapshot = await resolveEffectivePrice(input.tenantId, input.siteId, input.serviceId, chosenStaffId);
  const serviceName = await serviceNameFor(input.tenantId, input.serviceId);
  if (serviceName == null) return { ok: false, error: 'not_found', message: 'Service not found.' };

  // Per-staff service window (the chosen staff's own duration), plus service-level buffers.
  const serviceEnd = candidate.service_end_at;
  const durationMinSnapshot = Math.round((serviceEnd.getTime() - input.startAt.getTime()) / MS_PER_MIN);
  const blockedFrom = new Date(input.startAt.getTime() - avail.buffers.before_min * MS_PER_MIN);
  const blockedUntil = new Date(serviceEnd.getTime() + avail.buffers.after_min * MS_PER_MIN);

  // 3. Transaction: resolve identity, insert (exclusion-guarded), audit event.
  try {
    const created = await withTransaction(async (client) => {
      let contactId: string | null = null;
      if (input.channel && input.channelUserId) {
        const contact = await resolveOrCreateContact(
          {
            tenantId: input.tenantId,
            clientId,
            channel: input.channel,
            channelUserId: input.channelUserId,
            name: input.customerName,
            phone: input.customerPhone,
            email: input.customerEmail,
          },
          client,
        );
        contactId = contact.id;
      }

      let sourceConversationId: string | null = null;
      if (input.workflowRef && input.conversationRef) {
        const conv = await getOrCreateConversation(input.tenantId, input.workflowRef, input.conversationRef);
        sourceConversationId = conv.id;
        if (contactId) await linkConversationToContact(input.tenantId, conv.id, contactId, client);
      }

      const appt = await insertAppointment(client, {
        tenantId: input.tenantId,
        clientId,
        siteId: input.siteId,
        contactId,
        sourceConversationId,
        staffId: chosenStaffId,
        serviceId: input.serviceId,
        startAt: input.startAt,
        serviceEndAt: serviceEnd,
        blockedFrom,
        blockedUntil,
        serviceNameSnapshot: serviceName,
        durationMinSnapshot,
        priceSnapshot,
        bufferBeforeMinSnapshot: avail.buffers.before_min,
        bufferAfterMinSnapshot: avail.buffers.after_min,
        origin: input.origin,
        createdByType: input.createdByType,
        createdByUserId: input.createdByUserId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      });

      await recordAppointmentEvent(
        {
          tenantId: input.tenantId,
          appointmentId: appt.id,
          eventType: 'appointment_created',
          actorType: input.createdByType,
          actorUserId: input.createdByUserId ?? null,
          detail: {
            origin: input.origin,
            staff_id: appt.staff_id,
            requested_staff_id: input.staffId ?? null,
            start_at: appt.start_at,
            service_end_at: appt.service_end_at,
          },
        },
        client,
      );
      return appt;
    });

    // 4. Realtime AFTER commit.
    await recordSchedulingEvent({
      tenantId: created.tenant_id,
      clientId: created.client_id,
      siteId: created.site_id,
      eventType: 'appointment.created',
      payload: { appointment_id: created.id, staff_id: created.staff_id, start_at: created.start_at, contact_id: created.contact_id },
    });
    return { ok: true, value: created };
  } catch (err) {
    if (isExclusionViolation(err)) {
      return { ok: false, error: 'conflict_slot', message: 'That time was just booked. Please pick another.' };
    }
    if (isDeadlock(err)) {
      // The per-staff advisory lock should prevent this; preserve the original
      // error internally before mapping to a conflict (defense-in-depth).
      logger.warn({ err, staffId: chosenStaffId, startAt: input.startAt }, 'createAppointment: deadlock mapped to conflict_slot');
      return { ok: false, error: 'conflict_slot', message: 'That time was just booked. Please pick another.' };
    }
    if (isUniqueViolation(err) && input.idempotencyKey) {
      // Concurrent same-key insert won the race: fetch and dedup/conflict.
      const existing = await findByIdempotencyKey(input.tenantId, input.idempotencyKey);
      if (existing) {
        return samePayload(existing, input)
          ? { ok: true, value: existing, deduped: true }
          : { ok: false, error: 'conflict_idempotency', message: 'Idempotency-Key reused with a different payload.' };
      }
    }
    throw err;
  }
}

async function serviceNameFor(tenantId: string, serviceId: string): Promise<string | null> {
  const r = await query<{ name: string }>(`SELECT name FROM services WHERE id = $1 AND tenant_id = $2`, [serviceId, tenantId]);
  return r.rows[0]?.name ?? null;
}

// ── Status transitions (state machine) ─────────────────────────────────────────

const TERMINAL: AppointmentStatus[] = ['completed', 'cancelled', 'no_show'];

const LEGAL_STATUS: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'completed', 'cancelled', 'no_show'],
  confirmed: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show: [],
};

const EVENT_FOR: Record<Exclude<AppointmentStatus, 'scheduled'>, 'appointment_confirmed' | 'appointment_completed' | 'appointment_cancelled' | 'appointment_no_show'> = {
  confirmed: 'appointment_confirmed',
  completed: 'appointment_completed',
  cancelled: 'appointment_cancelled',
  no_show: 'appointment_no_show',
};

export interface TransitionInput {
  tenantId: string;
  appointmentId: string;
  actorType: ActorType;
  actorUserId?: string | null;
  reason?: string | null;
  /** When set (a member), the appointment must belong to this client, else it is
   * treated as not-found (no cross-client action, no existence leak). */
  scopeClientId?: string | null;
}

/** Apply a status transition (confirm/complete/cancel/no_show) under a row lock,
 * validating the state machine. Never physically deletes (cancel = status change). */
export async function transitionStatus(
  target: Exclude<AppointmentStatus, 'scheduled'>,
  input: TransitionInput,
): Promise<BookingResult<AppointmentRow>> {
  try {
    const result = await withTransaction(async (client) => {
      const current = await getAppointmentForUpdate(client, input.tenantId, input.appointmentId);
      if (!current) return { kind: 'not_found' as const };
      if (input.scopeClientId && current.client_id !== input.scopeClientId) return { kind: 'not_found' as const };
      if (!LEGAL_STATUS[current.status].includes(target)) {
        return { kind: 'invalid' as const, from: current.status };
      }
      const updated = await setStatus(client, input.tenantId, input.appointmentId, target);
      await recordAppointmentEvent(
        {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          eventType: EVENT_FOR[target],
          actorType: input.actorType,
          actorUserId: input.actorUserId ?? null,
          detail: { from: current.status, to: target, reason: input.reason ?? null },
        },
        client,
      );
      return { kind: 'ok' as const, updated };
    });

    if (result.kind === 'not_found') return { ok: false, error: 'not_found', message: 'Appointment not found.' };
    if (result.kind === 'invalid') {
      return { ok: false, error: 'invalid_transition', message: `Cannot move a ${result.from} appointment to ${target}.` };
    }
    await recordSchedulingEvent({
      tenantId: result.updated.tenant_id,
      clientId: result.updated.client_id,
      siteId: result.updated.site_id,
      eventType: target === 'cancelled' ? 'appointment.cancelled' : 'appointment.status_changed',
      payload: { appointment_id: result.updated.id, status: target, staff_id: result.updated.staff_id, start_at: result.updated.start_at },
    });
    return { ok: true, value: result.updated };
  } catch (err) {
    throw err;
  }
}

// ── Reschedule ─────────────────────────────────────────────────────────────────

export interface RescheduleInput {
  tenantId: string;
  appointmentId: string;
  startAt: Date;
  staffId?: string | null; // null = keep current staff
  actorType: ActorType;
  actorUserId?: string | null;
  scopeClientId?: string | null;
  now?: Date;
}

/** Reschedule keeps the SAME appointment id, revalidates availability for the new
 * interval, moves it in a transaction (exclusion-guarded), bumps version, and
 * writes an event with old + new values. Only non-terminal appointments move. */
export async function rescheduleAppointment(input: RescheduleInput): Promise<BookingResult<AppointmentRow>> {
  const now = input.now ?? new Date();
  try {
    const outcome = await withTransaction(async (client) => {
      const current = await getAppointmentForUpdate(client, input.tenantId, input.appointmentId);
      if (!current) return { kind: 'not_found' as const };
      if (input.scopeClientId && current.client_id !== input.scopeClientId) return { kind: 'not_found' as const };
      if (TERMINAL.includes(current.status)) return { kind: 'invalid' as const, from: current.status };

      const targetStaff = input.staffId ?? current.staff_id;

      // Revalidate the new slot with the engine (excluding THIS appointment's own
      // block is unnecessary: if unchanged it just re-offers, and the exclusion
      // constraint ignores same-row via the UPDATE). Use the snapshot timing so a
      // later catalogue change never reshapes an existing booking.
      const check = await isSlotAvailable(
        {
          tenantId: input.tenantId,
          siteId: current.site_id,
          serviceId: current.service_id,
          staffId: targetStaff,
          startAt: input.startAt,
          now,
        },
      );
      // The engine counts the current appointment as "busy"; allow the slot if it
      // is exactly the appointment's current interval (a no-op move) OR the engine
      // offers it. We compute the new interval from the SNAPSHOT duration/buffers.
      const dur = current.duration_min_snapshot;
      const bBefore = current.buffer_before_min_snapshot;
      const bAfter = current.buffer_after_min_snapshot;
      const serviceEnd = new Date(input.startAt.getTime() + dur * MS_PER_MIN);
      const blockedFrom = new Date(input.startAt.getTime() - bBefore * MS_PER_MIN);
      const blockedUntil = new Date(serviceEnd.getTime() + bAfter * MS_PER_MIN);

      const sameInterval =
        targetStaff === current.staff_id && input.startAt.getTime() === current.start_at.getTime();
      if (!sameInterval && !check.available) {
        return { kind: 'unavailable' as const };
      }

      const moved = await moveInterval(client, input.tenantId, input.appointmentId, {
        staffId: targetStaff,
        startAt: input.startAt,
        serviceEndAt: serviceEnd,
        blockedFrom,
        blockedUntil,
      });
      await recordAppointmentEvent(
        {
          tenantId: input.tenantId,
          appointmentId: input.appointmentId,
          eventType: 'appointment_rescheduled',
          actorType: input.actorType,
          actorUserId: input.actorUserId ?? null,
          detail: {
            from: { staff_id: current.staff_id, start_at: current.start_at, service_end_at: current.service_end_at },
            to: { staff_id: moved.staff_id, start_at: moved.start_at, service_end_at: moved.service_end_at },
          },
        },
        client,
      );
      return { kind: 'ok' as const, moved };
    });

    if (outcome.kind === 'not_found') return { ok: false, error: 'not_found', message: 'Appointment not found.' };
    if (outcome.kind === 'invalid') {
      return { ok: false, error: 'invalid_transition', message: `Cannot reschedule a ${outcome.from} appointment.` };
    }
    if (outcome.kind === 'unavailable') {
      return { ok: false, error: 'unavailable', message: 'The new time is not available.' };
    }
    await recordSchedulingEvent({
      tenantId: outcome.moved.tenant_id,
      clientId: outcome.moved.client_id,
      siteId: outcome.moved.site_id,
      eventType: 'appointment.rescheduled',
      payload: { appointment_id: outcome.moved.id, staff_id: outcome.moved.staff_id, start_at: outcome.moved.start_at },
    });
    return { ok: true, value: outcome.moved };
  } catch (err) {
    if (isExclusionViolation(err)) {
      return { ok: false, error: 'conflict_slot', message: 'That time was just booked. Please pick another.' };
    }
    if (isDeadlock(err)) {
      logger.warn({ err, appointmentId: input.appointmentId, startAt: input.startAt }, 'rescheduleAppointment: deadlock mapped to conflict_slot');
      return { ok: false, error: 'conflict_slot', message: 'That time was just booked. Please pick another.' };
    }
    throw err;
  }
}
