import { isDeadlock, isExclusionViolation, isUniqueViolation, query, withTransaction } from '../db/client.js';
import { logger } from '../logger.js';
import { linkConversationToContactIfUnlinked, setContactConsent, type MessagingConsent } from '../db/repositories/contacts.js';
import { resolveContactByIdentity, contactBelongsToClient, findContactIdsByIdentity, classifyIdentity, type ResolveIdentityInput } from '../db/repositories/contactIdentities.js';
import { getOrCreateConversation } from '../db/repositories/handoff.js';
import { normalizeE164, dialingRegionForTimezone } from './phone.js';
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
import { isSchedulingBookable, isSchedulingEnabledForUpdate } from '../db/repositories/clientModules.js';

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
  | 'invalid_transition' // illegal status change / reschedule from terminal
  | 'module_disabled' // the client's scheduling module is off (incl. concurrent disable)
  | 'contact_conflict' // explicit contact_id disagrees with the typed identity (C-4.1)
  | 'invalid_phone'; // customer_phone can't be normalized for the site's region (QA-3)

export type BookingResult<T> = { ok: true; value: T; deduped?: boolean } | { ok: false; error: BookingError; message: string };

export interface CreateAppointmentInput {
  tenantId: string;
  siteId: string;
  serviceId: string;
  staffId?: string | null; // null/undefined = "any"
  startAt: Date;
  /** EXPLICIT contact to attach to (C-4.1), an ALTERNATIVE to identity resolution — when
   *  set, the contact is validated to belong to (tenant, scopeClientId) and is NEVER
   *  created or mutated. If identity strings are ALSO supplied and resolve to a different
   *  existing contact, the booking is refused (contact_conflict). */
  contactId?: string | null;
  // Identity (all optional — a walk-in may have none).
  workflowRef?: string | null;
  conversationRef?: string | null;
  channel?: string | null;
  channelUserId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  /** I-1: additional identities the booking declares for the appointment's contact (the
   *  attendee) — attached through the same identity chokepoint as everything else. Applies to
   *  the resolve paths (customer_phone / channel_user_id); the EXPLICIT-contact path (contactId)
   *  never mutates the contact, so identities are ignored there. */
  identities?: ResolveIdentityInput['identities'];
  // Consent (C-2, STORE-ONLY): an automation may record an opt-in/opt-out on the contact.
  messagingConsent?: MessagingConsent | null;
  consentSource?: string | null;
  // Provenance.
  origin: AppointmentOrigin;
  createdByType: ActorType;
  createdByUserId?: string | null;
  idempotencyKey?: string | null;
  /** REQUIRED authorization scope: the site's client MUST equal this, else
   * not_found. Every production caller (n8n API, public booking, internal
   * actions, seed) resolves and passes it — there is no scope-less path. */
  scopeClientId: string;
  now?: Date;
}

/** True when a required scope value is present (non-empty string). Callers may be
 * untyped JS, so we fail closed at runtime rather than trust the type. */
function hasScope(scopeClientId: unknown): scopeClientId is string {
  return typeof scopeClientId === 'string' && scopeClientId.length > 0;
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

/**
 * Decide the outcome for an idempotency-key hit. Guards, in order:
 *  - CROSS-CLIENT collision (Idempotency-Key is tenant-scoped): if scopeClientId
 *    is set and the existing appointment belongs to a DIFFERENT client, never
 *    project it — treat as a key reused with a different payload (conflict).
 *  - different payload → conflict.
 *  - scheduling disabled for the existing appointment's client → module_disabled
 *    (a replay must not succeed once the module is off).
 *  - otherwise → the deduped replay.
 */
async function replayOrConflict(
  existing: AppointmentRow,
  input: CreateAppointmentInput,
): Promise<BookingResult<AppointmentRow>> {
  // Unconditional cross-client guard: a key hit for a DIFFERENT client's
  // appointment is never projected — treated as a key reused with a different
  // payload. (scopeClientId is guaranteed present by the caller's fail-closed check.)
  if (existing.client_id !== input.scopeClientId) {
    return { ok: false, error: 'conflict_idempotency', message: 'Idempotency-Key reused with a different payload.' };
  }
  if (!samePayload(existing, input)) {
    return { ok: false, error: 'conflict_idempotency', message: 'Idempotency-Key reused with a different payload.' };
  }
  if (!(await isSchedulingBookable(input.tenantId, existing.client_id))) {
    return { ok: false, error: 'module_disabled', message: 'Scheduling is disabled for this client.' };
  }
  return { ok: true, value: existing, deduped: true };
}

export async function createAppointment(
  input: CreateAppointmentInput,
): Promise<BookingResult<AppointmentRow>> {
  // 0. FAIL CLOSED: a missing/empty scope (an untyped JS caller) is rejected
  //    before touching idempotency, availability or any write — no reads, no leak.
  if (!hasScope(input.scopeClientId)) {
    return { ok: false, error: 'not_found', message: 'Service is not offered at this site.' };
  }
  const now = input.now ?? new Date();

  // 1. Idempotency short-circuit (before any writes) — with the cross-client +
  //    module-disabled guards.
  if (input.idempotencyKey) {
    const existing = await findByIdempotencyKey(input.tenantId, input.idempotencyKey);
    if (existing) return replayOrConflict(existing, input);
  }

  // 2. Resolve timing + choose a concrete staff via the availability engine.
  const avail = await loadAvailability({
    tenantId: input.tenantId,
    siteId: input.siteId,
    serviceId: input.serviceId,
    staffId: input.staffId ?? null,
    from: new Date(input.startAt.getTime() - 60 * MS_PER_MIN),
    // The upper bound must exceed startAt + serviceDuration, else availability.ts
    // (`s + durMs > rangeEnd` → skip) filters out the requested start for any service
    // LONGER than this window and the booking 409s `unavailable` even though the wide-
    // window availability endpoint offered it (C-1: a 60-min window silently blocked
    // every 75-min "Corte + barba"). Any single-day service fits within 24h; the free
    // interval + min-notice + horizon remain the real gates. We only .find() the exact
    // start, so the extra candidates are harmless.
    to: new Date(input.startAt.getTime() + 24 * 60 * MS_PER_MIN),
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
  // Unconditional: the resolved site's client MUST match the required scope.
  if (clientId !== input.scopeClientId) {
    return { ok: false, error: 'not_found', message: 'Service is not offered at this site.' };
  }
  const priceSnapshot = await resolveEffectivePrice(input.tenantId, input.siteId, input.serviceId, chosenStaffId);
  const serviceName = await serviceNameFor(input.tenantId, clientId, input.serviceId);
  if (serviceName == null) return { ok: false, error: 'not_found', message: 'Service not found.' };

  // Per-staff service window (the chosen staff's own duration), plus service-level buffers.
  const serviceEnd = candidate.service_end_at;
  const durationMinSnapshot = Math.round((serviceEnd.getTime() - input.startAt.getTime()) / MS_PER_MIN);
  const blockedFrom = new Date(input.startAt.getTime() - avail.buffers.before_min * MS_PER_MIN);
  const blockedUntil = new Date(serviceEnd.getTime() + avail.buffers.after_min * MS_PER_MIN);

  // 2b. §2: a customer_phone typed in chat may be LOCAL (no country code). Normalize it
  //     against the SITE's dialing region (derived from its timezone) BEFORE any write, so
  //     "3058830676", "573058830676" and "+57 305 883 0676" all resolve to ONE contact.
  //     Ambiguous → reject (ask for the country code) rather than guess a wrong country.
  //     channel_user_id (the wa_id) is NOT touched — it already carries its country code.
  let normalizedCustomerPhone: string | null = null;
  if (typeof input.customerPhone === 'string' && input.customerPhone.trim() !== '') {
    normalizedCustomerPhone = normalizeE164(input.customerPhone, {
      defaultRegion: dialingRegionForTimezone(avail.site.timezone),
    });
    if (!normalizedCustomerPhone) {
      return {
        ok: false,
        error: 'invalid_phone',
        message: `Could not read the phone number “${input.customerPhone.trim()}”. Send it with the country code, e.g. +57 300 123 4567.`,
      };
    }
  }

  // 3. Transaction: RE-CHECK the scheduling module (FOR SHARE, so a concurrent
  //    disable serializes with us), then resolve identity, insert
  //    (exclusion-guarded), audit event — all or nothing.
  try {
    const created = await withTransaction(async (client) => {
      // Transactional module gate: if scheduling is off for this client (or was
      // just turned off concurrently), write NOTHING.
      if (!(await isSchedulingEnabledForUpdate(client, input.tenantId, clientId))) {
        return { kind: 'module_disabled' as const };
      }
      let contactId: string | null = null;
      // QA-3: may the conversation be linked to the appointment contact? ONLY when that
      // contact owns the conversation's OWN identity (channel_user_id) — never when the
      // appointment is for a different customer_phone (a third party). Set per branch.
      let contactOwnsConversation = false;

      if (input.contactId) {
        // C-4.1: an EXPLICIT contact (e.g. booked from the contact record). Validate it
        // belongs to this client — fail closed — and NEVER create or mutate it.
        if (!(await contactBelongsToClient(input.tenantId, clientId, input.contactId, client))) {
          return { kind: 'contact_not_found' as const };
        }
        // If identity strings were ALSO supplied, they must not point at a DIFFERENT
        // existing contact (read-only check — no resolution/creation). contact_id wins.
        if (input.channel && input.channelUserId) {
          const mapped = await findContactIdsByIdentity(
            { tenantId: input.tenantId, clientId, channelUserId: input.channelUserId, phone: normalizedCustomerPhone, email: input.customerEmail },
            client,
          );
          if (mapped.some((id) => id !== input.contactId)) {
            return { kind: 'contact_conflict' as const };
          }
        }
        contactId = input.contactId;
        // The conflict check proved channel_user_id maps to this contact (or to nobody), so
        // the explicit contact owns the conversation identity — safe to link.
        contactOwnsConversation = true;
        // NB: no consent write here — recording consent would mutate the contact, which
        // the explicit-contact path must not do.
      } else if (normalizedCustomerPhone) {
        // §1b: customer_phone identifies WHO THE APPOINTMENT IS FOR. Resolve/create THAT
        // contact from the PHONE ALONE — never mixing in the writer's channel_user_id, which
        // would merge two different people into one contact. This contact owns the booking.
        const forWhom = await resolveContactByIdentity(
          {
            tenantId: input.tenantId,
            clientId,
            channel: input.channel ?? 'booking',
            channelUserId: normalizedCustomerPhone,
            name: input.customerName,
            phone: normalizedCustomerPhone,
            email: input.customerEmail,
            // I-1: the declared identities describe WHO the appointment is for → the attendee.
            identities: input.identities,
          },
          client,
        );
        contactId = forWhom.contact.id;
        if (input.messagingConsent) {
          await setContactConsent(input.tenantId, clientId, contactId, input.messagingConsent, input.consentSource ?? null, client);
        }
        // The conversation belongs to the WRITER (channel_user_id), NOT to this phone —
        // unless the phone IS the writer's own number (self-booking with a redundant phone),
        // in which case they resolve to the same identity and linking is correct.
        const convIdent = classifyIdentity(input.channelUserId)?.value;
        const phoneIdent = classifyIdentity(normalizedCustomerPhone)?.value;
        contactOwnsConversation = !!convIdent && convIdent === phoneIdent;
      } else if (input.channel && input.channelUserId) {
        // Normal case (no customer_phone): the WRITER is the customer. Unchanged — resolve
        // through the identity spine from the conversation's own identity.
        const resolved = await resolveContactByIdentity(
          {
            tenantId: input.tenantId,
            clientId,
            channel: input.channel,
            channelUserId: input.channelUserId,
            name: input.customerName,
            email: input.customerEmail,
            // I-1: the writer is the customer — attach every identity they declared.
            identities: input.identities,
          },
          client,
        );
        contactId = resolved.contact.id;
        if (input.messagingConsent) {
          await setContactConsent(input.tenantId, clientId, contactId, input.messagingConsent, input.consentSource ?? null, client);
        }
        contactOwnsConversation = true;
      }

      let sourceConversationId: string | null = null;
      if (input.workflowRef && input.conversationRef) {
        const conv = await getOrCreateConversation(input.tenantId, input.workflowRef, input.conversationRef, client);
        // Attribution is UNCONDITIONAL — the appointment records where the request came from.
        sourceConversationId = conv.id;
        // Linking the conversation to the contact is NULL-GUARDED (never overwrites) AND only
        // when that contact owns the conversation's own identity — so a third-party booking
        // records attribution without ever re-pointing the writer's conversation.
        if (contactId && contactOwnsConversation) {
          await linkConversationToContactIfUnlinked(input.tenantId, conv.id, contactId, client);
        }
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
      return { kind: 'ok' as const, appt };
    });

    // Scheduling was disabled (possibly concurrently) → zero writes, module_disabled.
    if (created.kind === 'module_disabled') {
      return { ok: false, error: 'module_disabled', message: 'Scheduling is disabled for this client.' };
    }
    // C-4.1 explicit-contact guards (zero writes — the tx returned before insert).
    if (created.kind === 'contact_not_found') {
      return { ok: false, error: 'not_found', message: 'Contact not found for this client.' };
    }
    if (created.kind === 'contact_conflict') {
      return { ok: false, error: 'contact_conflict', message: 'The provided identity belongs to a different contact.' };
    }
    const appt = created.appt;

    // 4. Realtime AFTER commit.
    await recordSchedulingEvent({
      tenantId: appt.tenant_id,
      clientId: appt.client_id,
      siteId: appt.site_id,
      eventType: 'appointment.created',
      payload: { appointment_id: appt.id, staff_id: appt.staff_id, start_at: appt.start_at, contact_id: appt.contact_id },
    });
    return { ok: true, value: appt };
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
      // Concurrent same-key insert won the race: fetch and apply the same replay
      // guards (cross-client + module-disabled), never projecting a foreign appt.
      const existing = await findByIdempotencyKey(input.tenantId, input.idempotencyKey);
      if (existing) return replayOrConflict(existing, input);
    }
    throw err;
  }
}

async function serviceNameFor(tenantId: string, clientId: string, serviceId: string): Promise<string | null> {
  const r = await query<{ name: string }>(
    `SELECT name FROM services WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [serviceId, tenantId, clientId],
  );
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
  /** REQUIRED: the appointment must belong to this client, else not-found (no
   * cross-client action, no existence leak). */
  scopeClientId: string;
}

/** Apply a status transition (confirm/complete/cancel/no_show) under a row lock,
 * validating the state machine. Never physically deletes (cancel = status change). */
export async function transitionStatus(
  target: Exclude<AppointmentStatus, 'scheduled'>,
  input: TransitionInput,
): Promise<BookingResult<AppointmentRow>> {
  // FAIL CLOSED: no scope → not_found before locking/reading the appointment.
  if (!hasScope(input.scopeClientId)) return { ok: false, error: 'not_found', message: 'Appointment not found.' };
  try {
    const result = await withTransaction(async (client) => {
      const current = await getAppointmentForUpdate(client, input.tenantId, input.appointmentId);
      if (!current) return { kind: 'not_found' as const };
      if (current.client_id !== input.scopeClientId) return { kind: 'not_found' as const };
      // Transactional module gate (after scope): a disabled client can't be
      // mutated, even by a concurrent disable — no status/version/event change.
      if (!(await isSchedulingEnabledForUpdate(client, input.tenantId, current.client_id))) {
        return { kind: 'module_disabled' as const };
      }
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
    if (result.kind === 'module_disabled') {
      return { ok: false, error: 'module_disabled', message: 'Scheduling is disabled for this client.' };
    }
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
  /** REQUIRED: the appointment must belong to this client, else not-found. */
  scopeClientId: string;
  now?: Date;
}

/** Reschedule keeps the SAME appointment id, revalidates availability for the new
 * interval, moves it in a transaction (exclusion-guarded), bumps version, and
 * writes an event with old + new values. Only non-terminal appointments move. */
export async function rescheduleAppointment(input: RescheduleInput): Promise<BookingResult<AppointmentRow>> {
  // FAIL CLOSED: no scope → not_found before locking/reading the appointment.
  if (!hasScope(input.scopeClientId)) return { ok: false, error: 'not_found', message: 'Appointment not found.' };
  const now = input.now ?? new Date();
  try {
    const outcome = await withTransaction(async (client) => {
      const current = await getAppointmentForUpdate(client, input.tenantId, input.appointmentId);
      if (!current) return { kind: 'not_found' as const };
      if (current.client_id !== input.scopeClientId) return { kind: 'not_found' as const };
      // Transactional module gate (after scope): disabled → no interval/version/event.
      if (!(await isSchedulingEnabledForUpdate(client, input.tenantId, current.client_id))) {
        return { kind: 'module_disabled' as const };
      }
      if (TERMINAL.includes(current.status)) return { kind: 'invalid' as const, from: current.status };

      const targetStaff = input.staffId ?? current.staff_id;

      // Revalidate the new slot with the engine, EXCLUDING this appointment's own block
      // from the busy set (C-2) — otherwise a small move that overlaps its current time
      // ("11:45 → 12:15") would be blocked by itself. Use the snapshot timing so a later
      // catalogue change never reshapes an existing booking.
      const check = await isSlotAvailable(
        {
          tenantId: input.tenantId,
          siteId: current.site_id,
          serviceId: current.service_id,
          staffId: targetStaff,
          startAt: input.startAt,
          now,
          excludeAppointmentId: input.appointmentId,
        },
      );
      // New interval from the SNAPSHOT duration/buffers (for moveInterval below).
      const dur = current.duration_min_snapshot;
      const bBefore = current.buffer_before_min_snapshot;
      const bAfter = current.buffer_after_min_snapshot;
      const serviceEnd = new Date(input.startAt.getTime() + dur * MS_PER_MIN);
      const blockedFrom = new Date(input.startAt.getTime() - bBefore * MS_PER_MIN);
      const blockedUntil = new Date(serviceEnd.getTime() + bAfter * MS_PER_MIN);

      if (!check.available) {
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
    if (outcome.kind === 'module_disabled') {
      return { ok: false, error: 'module_disabled', message: 'Scheduling is disabled for this client.' };
    }
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
