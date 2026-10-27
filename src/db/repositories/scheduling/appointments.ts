import type { PoolClient, QueryResultRow } from 'pg';
import { query, firstRowOrThrow } from '../../client.js';
import { utcToZonedParts } from '../../../scheduling/timezone.js';

/**
 * Appointments repository — low-level, client-aware primitives (they accept an
 * optional txn client) plus tenant-scoped reads. The transactional ORCHESTRATION
 * (revalidate → insert → event → post-commit realtime) lives in
 * src/scheduling/booking.ts; this file only owns the SQL.
 */

export type AppointmentStatus = 'scheduled' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type AppointmentOrigin = 'public' | 'n8n' | 'internal' | 'walk_in';
export type ActorType = 'system' | 'agent' | 'public' | 'n8n';

export type AppointmentEventType =
  | 'appointment_created'
  | 'appointment_rescheduled'
  | 'appointment_cancelled'
  | 'appointment_confirmed'
  | 'appointment_completed'
  | 'appointment_no_show'
  | 'manual_note'
  | 'mode_changed'
  | 'escalation'
  // JP-4: editing an existing appointment.
  | 'appointment_service_changed'
  | 'appointment_time_corrected';

export interface AppointmentRow {
  id: string;
  public_reference: string;
  tenant_id: string;
  client_id: string;
  site_id: string;
  contact_id: string | null;
  source_conversation_id: string | null;
  /** PL-1: the sales opportunity this booking belongs to (linked post-commit by the pipeline). */
  opportunity_id: string | null;
  staff_id: string;
  service_id: string;
  start_at: Date;
  service_end_at: Date;
  blocked_from: Date;
  blocked_until: Date;
  service_name_snapshot: string;
  duration_min_snapshot: number;
  price_snapshot: string | null;
  buffer_before_min_snapshot: number;
  buffer_after_min_snapshot: number;
  status: AppointmentStatus;
  origin: AppointmentOrigin;
  created_by_type: ActorType;
  created_by_user_id: string | null;
  idempotency_key: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  /** Walk-in details typed WITHOUT saving a contact (migration 1819). Display only — never
   *  an identity: they are not matched, merged nor used to message anyone. */
  guest_name: string | null;
  guest_phone: string | null;
  guest_email: string | null;
}

export interface InsertAppointmentInput {
  tenantId: string;
  clientId: string;
  siteId: string;
  contactId: string | null;
  sourceConversationId: string | null;
  staffId: string;
  serviceId: string;
  startAt: Date;
  serviceEndAt: Date;
  blockedFrom: Date;
  blockedUntil: Date;
  serviceNameSnapshot: string;
  durationMinSnapshot: number;
  priceSnapshot: string | null;
  bufferBeforeMinSnapshot: number;
  bufferAfterMinSnapshot: number;
  origin: AppointmentOrigin;
  createdByType: ActorType;
  createdByUserId: string | null;
  idempotencyKey: string | null;
  /** Only for an appointment with NO contact (a walk-in not saved as a contact). */
  guest?: { name: string | null; phone: string | null; email: string | null } | null;
}

/** Raw insert. May throw SQLSTATE 23P01 (overlap → the anti-double-book guard) or
 * 23505 (idempotency-key collision) — the booking service maps those.
 *
 * Takes a transaction-scoped ADVISORY LOCK keyed by staff_id first: concurrent
 * inserts for the SAME staff serialize, so the loser gets a clean 23P01 instead of
 * a GiST-exclusion DEADLOCK (two overlapping inserts each waiting on the other's
 * pending tuple). Different staff hash to different keys and never contend. */
export async function insertAppointment(client: PoolClient, input: InsertAppointmentInput): Promise<AppointmentRow> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.staffId]);
  const r = await client.query<AppointmentRow>(
    `INSERT INTO appointments (
        tenant_id, client_id, site_id, contact_id, source_conversation_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot,
        buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type, created_by_user_id, idempotency_key,
        guest_name, guest_phone, guest_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'scheduled',$17,$18,$19,$20,$21,$22,$23)
     RETURNING *`,
    [
      input.tenantId, input.clientId, input.siteId, input.contactId, input.sourceConversationId, input.staffId, input.serviceId,
      input.startAt, input.serviceEndAt, input.blockedFrom, input.blockedUntil,
      input.serviceNameSnapshot, input.durationMinSnapshot, input.priceSnapshot,
      input.bufferBeforeMinSnapshot, input.bufferAfterMinSnapshot,
      input.origin, input.createdByType, input.createdByUserId, input.idempotencyKey,
      input.contactId ? null : input.guest?.name ?? null,
      input.contactId ? null : input.guest?.phone ?? null,
      input.contactId ? null : input.guest?.email ?? null,
    ],
  );
  return firstRowOrThrow(r, 'insertAppointment');
}

/**
 * PUBLIC-BOOKING CAP: how many ACTIVE (scheduled/confirmed) appointments that start
 * after `now` this site already holds for the contact(s) owning this E.164 phone.
 *
 * Runs on the booking transaction and FIRST takes a transaction-scoped advisory lock keyed
 * by (tenant, site, phone), so two concurrent public bookings for the same phone serialize
 * here: the second one counts AFTER the first commits and can't slip past the cap. The
 * lock is taken before the per-staff insert lock, always in that order, so the two can
 * never form a cycle. The phone only feeds the lock hash — nothing is persisted.
 *
 * Matches the phone through the identity spine (contact_identities, the canonical
 * mapping) and the contact's own phone_e164, both scoped to (tenant, client).
 */
export async function countActiveFutureForPhoneAtSite(
  client: PoolClient,
  input: { tenantId: string; clientId: string; siteId: string; phoneE164: string; now: Date },
): Promise<number> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `public-booking-cap:${input.tenantId}:${input.siteId}:${input.phoneE164}`,
  ]);
  const r = await client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM appointments a
      WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.site_id = $3
        AND a.status IN ('scheduled','confirmed')
        AND a.start_at > $4
        AND a.contact_id IN (
              SELECT ci.contact_id FROM contact_identities ci
               WHERE ci.tenant_id = $1 AND ci.client_id = $2 AND ci.kind = 'phone' AND ci.value = $5
              UNION
              SELECT c.id FROM contacts c
               WHERE c.tenant_id = $1 AND c.client_id = $2 AND c.phone_e164 = $5
            )`,
    [input.tenantId, input.clientId, input.siteId, input.now, input.phoneE164],
  );
  return r.rows[0]?.n ?? 0;
}

/** Record an audit event on the same txn client (or pool). */
export async function recordAppointmentEvent(
  input: {
    tenantId: string;
    appointmentId: string;
    eventType: AppointmentEventType;
    actorType: ActorType;
    actorUserId?: string | null;
    detail?: Record<string, unknown>;
  },
  client?: PoolClient,
): Promise<void> {
  const run = (text: string, params: unknown[]) => (client ? client.query(text, params) : query(text, params));
  await run(
    `INSERT INTO appointment_events (tenant_id, appointment_id, event_type, actor_type, actor_user_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.tenantId,
      input.appointmentId,
      input.eventType,
      input.actorType,
      input.actorUserId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

export async function findByIdempotencyKey(
  tenantId: string,
  key: string,
  client?: PoolClient,
): Promise<AppointmentRow | null> {
  const run = <T extends QueryResultRow>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params) : query<T>(text, params);
  const r = await run<AppointmentRow>(
    `SELECT * FROM appointments WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, key],
  );
  return r.rows[0] ?? null;
}

export async function getAppointmentById(
  tenantId: string,
  id: string,
  client?: PoolClient,
): Promise<AppointmentRow | null> {
  const run = <T extends QueryResultRow>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params) : query<T>(text, params);
  const r = await run<AppointmentRow>(`SELECT * FROM appointments WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ?? null;
}

/** Lock a row FOR UPDATE inside a txn (status transitions / reschedule). */
export async function getAppointmentForUpdate(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<AppointmentRow | null> {
  const r = await client.query<AppointmentRow>(
    `SELECT * FROM appointments WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
    [id, tenantId],
  );
  return r.rows[0] ?? null;
}

/** Set status (+ bump version) inside a txn. Returns the updated row. */
export async function setStatus(
  client: PoolClient,
  tenantId: string,
  id: string,
  status: AppointmentStatus,
): Promise<AppointmentRow> {
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments SET status = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, status],
  );
  return firstRowOrThrow(r, 'setStatus');
}

/** Link a contact to an appointment that has NONE yet (inside a txn, row already locked).
 *  The typed guest details move into the contact, so they are cleared here. Refuses (null)
 *  when the appointment already has a contact — a link is never silently replaced. */
export async function attachAppointmentContact(
  client: PoolClient,
  tenantId: string,
  id: string,
  contactId: string,
): Promise<AppointmentRow | null> {
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments
        SET contact_id = $3, guest_name = NULL, guest_phone = NULL, guest_email = NULL,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND contact_id IS NULL RETURNING *`,
    [id, tenantId, contactId],
  );
  return r.rows[0] ?? null;
}

/** Replace the guest details of an appointment WITHOUT a contact (inside a txn). */
export async function updateAppointmentGuest(
  client: PoolClient,
  tenantId: string,
  id: string,
  guest: { name: string | null; phone: string | null; email: string | null },
): Promise<AppointmentRow | null> {
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments
        SET guest_name = $3, guest_phone = $4, guest_email = $5, version = version + 1, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 AND contact_id IS NULL RETURNING *`,
    [id, tenantId, guest.name, guest.phone, guest.email],
  );
  return r.rows[0] ?? null;
}

/** Move the interval (+ bump version) inside a txn. Relies on the exclusion
 * constraint to reject an overlapping new interval (23P01). */
export async function moveInterval(
  client: PoolClient,
  tenantId: string,
  id: string,
  next: {
    staffId: string;
    startAt: Date;
    serviceEndAt: Date;
    blockedFrom: Date;
    blockedUntil: Date;
  },
): Promise<AppointmentRow> {
  // Same per-staff advisory lock as insert, so a reschedule onto a contended slot
  // serializes into a clean 23P01 rather than a deadlock.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [next.staffId]);
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments
        SET staff_id = $3, start_at = $4, service_end_at = $5, blocked_from = $6, blocked_until = $7,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, next.staffId, next.startAt, next.serviceEndAt, next.blockedFrom, next.blockedUntil],
  );
  return firstRowOrThrow(r, 'moveInterval');
}

/**
 * JP-4 — swap an appointment's SERVICE (and the frozen snapshots it implies). The start stays put;
 * only the service identity, its snapshots, the price and the derived end/blocked_until move. Same
 * per-staff advisory lock as moveInterval so a concurrent write serializes into a clean 23P01.
 */
export async function changeServiceColumns(
  client: PoolClient,
  tenantId: string,
  id: string,
  next: {
    serviceId: string;
    serviceNameSnapshot: string;
    durationMinSnapshot: number;
    bufferBeforeMinSnapshot: number;
    bufferAfterMinSnapshot: number;
    priceSnapshot: string | null;
    serviceEndAt: Date;
    blockedFrom: Date;
    blockedUntil: Date;
  },
): Promise<AppointmentRow> {
  const r = await client.query<AppointmentRow>(
    `UPDATE appointments
        SET service_id = $3, service_name_snapshot = $4, duration_min_snapshot = $5,
            buffer_before_min_snapshot = $6, buffer_after_min_snapshot = $7, price_snapshot = $8,
            service_end_at = $9, blocked_from = $10, blocked_until = $11,
            version = version + 1, updated_at = now()
      WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [id, tenantId, next.serviceId, next.serviceNameSnapshot, next.durationMinSnapshot,
      next.bufferBeforeMinSnapshot, next.bufferAfterMinSnapshot, next.priceSnapshot,
      next.serviceEndAt, next.blockedFrom, next.blockedUntil],
  );
  return firstRowOrThrow(r, 'changeServiceColumns');
}

export interface ListAppointmentsFilters {
  clientId?: string | null;
  siteId?: string;
  staffId?: string;
  status?: AppointmentStatus | AppointmentStatus[];
  contactId?: string;
  /** C-7: an identity-resolved set of contact ids. `a.contact_id = ANY(...)` — an
   *  EMPTY array matches nothing (0 rows), so an identity that resolves to no
   *  contact CANNOT widen to the whole client. NULL contact_id is excluded (a
   *  `= ANY` never matches NULL), so identity-filtered lists never return walk-ins. */
  contactIds?: string[];
  conversationId?: string;
  from?: Date;
  to?: Date;
  /**
   * The machine list's `active=true`: "still actionable" — status IN (scheduled,
   * confirmed) AND service_end_at >= this instant. SEPARATE from `status` (they AND if
   * both are given); the boundary is service_end_at, not start_at, so an appointment in
   * progress right now stays in. An absolute timestamptz compare, so it never shifts with
   * a presentation `tz`. Pass `new Date()` at request time.
   */
  activeAt?: Date;
  limit?: number;
}

export interface AppointmentListItem extends AppointmentRow {
  staff_name: string | null;
  site_name: string | null;
  /** The appointment's site timezone — for per-row local-time labels (C-6); the list
   *  can span sites, so this can't be a single per-request value. */
  site_timezone: string;
  contact_name: string | null;
  /** The contact's main phone-or-email (C-7 identification), from ONE lateral join —
   *  never a per-row lookup. NULL for walk-ins / a contact with no phone/email.
   *  This SUPERSEDES the redesign's contact_phone: identity is canonical now, so the
   *  agenda drawer reads this instead of a raw contacts.phone_e164 column. */
  primary_identity: string | null;
}

/**
 * Tenant-scoped list with safe filters. CROSS-CLIENT IDENTITY DEFENSE: the DB
 * doesn't guarantee an appointment's contact/source-conversation stay within
 * its client, and site/staff rows are joined for display — so no joined
 * identity may leak across clients:
 *
 * - sites/staff are REQUIRED resources and join on tenant + ownership
 *   (si.client_id = a.client_id; st.site_id = a.site_id) as INNER joins — an
 *   inconsistent appointment (site or staff of another client) is EXCLUDED
 *   from the list entirely.
 * - contact joins on tenant + client; the projection takes contact_id FROM THE
 *   JOIN (ct.id, an explicit projection — never a.*), so a mislinked foreign
 *   contact yields contact_id = NULL and contact_name = NULL. The foreign UUID
 *   never reaches the caller.
 * - source_conversation_id is only projected when the conversation belongs to
 *   the tenant AND its CANONICAL workflow (most recently synced row for
 *   tenant + n8n_workflow_id — same criterion as the conversation reads)
 *   belongs to a.client_id; otherwise NULL.
 */
export async function listAppointments(
  tenantId: string,
  filters: ListAppointmentsFilters = {},
): Promise<AppointmentListItem[]> {
  const params: unknown[] = [tenantId];
  const where = ['a.tenant_id = $1'];
  const add = (frag: (i: number) => string, val: unknown) => {
    params.push(val);
    where.push(frag(params.length));
  };
  if (filters.clientId) add((i) => `a.client_id = $${i}`, filters.clientId);
  if (filters.siteId) add((i) => `a.site_id = $${i}`, filters.siteId);
  if (filters.staffId) add((i) => `a.staff_id = $${i}`, filters.staffId);
  if (filters.contactId) add((i) => `a.contact_id = $${i}`, filters.contactId);
  // Identity-resolved set: applied when the key is PRESENT (even if []), so an
  // identity that matched no contact yields 0 rows instead of the whole client.
  if (filters.contactIds !== undefined) add((i) => `a.contact_id = ANY($${i}::uuid[])`, filters.contactIds);
  if (filters.conversationId) add((i) => `a.source_conversation_id = $${i}`, filters.conversationId);
  if (filters.status) {
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
    add((i) => `a.status = ANY($${i}::text[])`, arr);
  }
  // active=true: still-actionable only — the two "open" statuses AND not yet ended. The
  // boundary is service_end_at (not start_at), so an appointment in progress stays active;
  // an ended one drops out. This is why the machine list stops returning past "scheduled"
  // rows that nothing ever transitions. Independent of `status` (both apply if both given).
  if (filters.activeAt) {
    add((i) => `a.status = ANY($${i}::text[])`, ['scheduled', 'confirmed']);
    add((i) => `a.service_end_at >= $${i}`, filters.activeAt);
  }
  if (filters.from) add((i) => `a.start_at >= $${i}`, filters.from);
  if (filters.to) add((i) => `a.start_at < $${i}`, filters.to);
  params.push(Math.min(filters.limit ?? 500, 1000));
  const r = await query<AppointmentListItem>(
    `SELECT a.id, a.public_reference, a.tenant_id, a.client_id, a.site_id,
            ct.id AS contact_id,
            sc.id AS source_conversation_id,
            a.staff_id, a.service_id,
            a.start_at, a.service_end_at, a.blocked_from, a.blocked_until,
            a.service_name_snapshot, a.duration_min_snapshot, a.price_snapshot,
            a.buffer_before_min_snapshot, a.buffer_after_min_snapshot,
            a.status, a.origin, a.created_by_type, a.created_by_user_id,
            a.idempotency_key, a.version, a.created_at, a.updated_at,
            a.guest_name, a.guest_phone, a.guest_email,
            st.name AS staff_name, si.name AS site_name, si.timezone AS site_timezone, ct.name AS contact_name,
            pid.value AS primary_identity
       FROM appointments a
       JOIN sites si
         ON si.id = a.site_id AND si.tenant_id = a.tenant_id AND si.client_id = a.client_id
       JOIN staff st
         ON st.id = a.staff_id AND st.tenant_id = a.tenant_id AND st.site_id = a.site_id
       LEFT JOIN contacts ct
         ON ct.id = a.contact_id AND ct.tenant_id = a.tenant_id AND ct.client_id = a.client_id
       LEFT JOIN LATERAL (
         SELECT ci.value
           FROM contact_identities ci
          WHERE ci.tenant_id = ct.tenant_id AND ci.client_id = ct.client_id AND ci.contact_id = ct.id
            AND ci.kind IN ('phone', 'email')
          ORDER BY (ci.kind = 'phone') DESC, ci.created_at ASC
          LIMIT 1
       ) pid ON true
       LEFT JOIN conversations sc
         ON sc.id = a.source_conversation_id
        AND sc.tenant_id = a.tenant_id
        AND EXISTS (
              SELECT 1
                FROM (SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
                        FROM workflows w
                       WHERE w.tenant_id = sc.tenant_id AND w.n8n_workflow_id = sc.n8n_workflow_id
                       ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST) cw
               WHERE cw.client_id = a.client_id
            )
      WHERE ${where.join(' AND ')}
      ORDER BY a.start_at ASC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

/**
 * Count FUTURE, still-active (scheduled|confirmed) appointments tied to a resource —
 * powers the deactivation guard (3d): "Padre G has 3 upcoming appointments." Scoped by
 * tenant + client; exactly one of staffId/serviceId/siteId identifies the resource.
 * Cancelled/completed/no-show and past appointments are NOT counted (they can't be
 * affected by deactivating a resource going forward). This never blocks or mutates —
 * it only informs the confirmation.
 */
export async function countUpcomingAppointmentsForResource(
  tenantId: string,
  filter: { clientId: string; staffId?: string; serviceId?: string; siteId?: string },
  now: Date = new Date(),
): Promise<number> {
  const col = filter.staffId ? 'staff_id' : filter.serviceId ? 'service_id' : filter.siteId ? 'site_id' : null;
  const val = filter.staffId ?? filter.serviceId ?? filter.siteId;
  if (!col || !val || !filter.clientId) return 0; // fail closed: no resource → nothing to warn about
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM appointments
      WHERE tenant_id = $1 AND client_id = $2 AND ${col} = $3
        AND status IN ('scheduled', 'confirmed') AND start_at >= $4`,
    [tenantId, filter.clientId, val, now],
  );
  return r.rows[0]?.n ?? 0;
}

/** An active appointment that OVERLAPS a proposed time-off block — powers the conflict
 *  flow (list them, keep or cancel; never auto-cancel). */
export interface OverlappingAppointment {
  id: string;
  staff_id: string;
  staff_name: string | null;
  start_at: Date;
  service_end_at: Date;
  service_name: string;
  contact_name: string | null;
  /** The typed name of a walk-in WITHOUT a contact (display only). */
  guest_name: string | null;
  status: string;
  service_id: string;
  duration_min: number;
}

/**
 * Active (scheduled|confirmed) appointments of a client's site that OVERLAP [from, to).
 * Overlap is `start_at < to AND service_end_at > from` (an appointment that starts before
 * the block but runs into it still conflicts). `staffId` limits to one staff member (a
 * staff block); omit it for a SITE closure (every staff at the site). Tenant+client scoped.
 */
export async function listActiveAppointmentsOverlapping(
  tenantId: string,
  filter: { clientId: string; siteId: string; staffId?: string | null; from: Date; to: Date },
): Promise<OverlappingAppointment[]> {
  const params: unknown[] = [tenantId, filter.clientId, filter.siteId, filter.from, filter.to];
  let staffClause = '';
  if (filter.staffId) {
    params.push(filter.staffId);
    staffClause = `AND a.staff_id = $${params.length}`;
  }
  const r = await query<OverlappingAppointment>(
    `SELECT a.id, a.staff_id, st.name AS staff_name, a.start_at, a.service_end_at,
            a.service_name_snapshot AS service_name, ct.name AS contact_name, a.guest_name, a.status,
            a.service_id, a.duration_min_snapshot AS duration_min
       FROM appointments a
       JOIN staff st ON st.id = a.staff_id AND st.tenant_id = a.tenant_id
       LEFT JOIN contacts ct
         ON ct.id = a.contact_id AND ct.tenant_id = a.tenant_id AND ct.client_id = a.client_id
      WHERE a.tenant_id = $1 AND a.client_id = $2 AND a.site_id = $3
        AND a.status IN ('scheduled', 'confirmed')
        AND a.start_at < $5 AND a.service_end_at > $4 ${staffClause}
      ORDER BY a.start_at`,
    params,
  );
  return r.rows;
}

/** A contact's active appointment described in words an agent/customer can read back:
 *  local day + time (in the appointment's OWN site tz) + service name. */
export interface ActiveAppointmentView {
  id: string;
  day: string; // YYYY-MM-DD (site-local)
  time: string; // HH:MM (site-local, 24h) — machine-readable
  service: string;
  /** The UTC instant + the appointment's own site tz, so a caller can render a spoken
   *  read-aloud label ("miércoles, 2 de septiembre at 3:30 p. m.") without re-deriving it. */
  startAt: string; // ISO-8601 UTC
  siteTimezone: string;
}
export type AppointmentByTimeMatch =
  | { status: 'ok'; id: string }
  | { status: 'none'; active: ActiveAppointmentView[] }
  | { status: 'ambiguous'; matches: ActiveAppointmentView[] };

function toActiveView(a: AppointmentListItem): ActiveAppointmentView {
  const p = utcToZonedParts(a.start_at, a.site_timezone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    id: a.id,
    day: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    service: a.service_name_snapshot,
    startAt: a.start_at.toISOString(),
    siteTimezone: a.site_timezone,
  };
}

/**
 * §3: identify a contact's ACTIVE (scheduled|confirmed) appointment by its LOCAL day+time —
 * the alternative to transcribing its UUID (the most destructive id to get wrong, on cancel).
 * Matching is per-appointment in its OWN site timezone, so the caller never needs a site_id.
 *   - exactly one active appointment at that day+time → ok(id);
 *   - none → the contact's active appointments (day/time/service) so the agent can re-offer;
 *   - more than one → ambiguous (never guess when a cancellation is at stake).
 * `time` must already be canonical "HH:MM" (parse the human form at the edge).
 */
export async function resolveActiveAppointmentByLocalTime(
  tenantId: string,
  clientId: string,
  contactIds: string[],
  day: string,
  time: string,
): Promise<AppointmentByTimeMatch> {
  if (contactIds.length === 0) return { status: 'none', active: [] };
  const appts = await listAppointments(tenantId, { clientId, contactIds, status: ['scheduled', 'confirmed'] });
  const views = appts.map(toActiveView);
  const matches = views.filter((v) => v.day === day && v.time === time);
  if (matches.length === 1) return { status: 'ok', id: matches[0].id };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  return { status: 'none', active: views };
}

export interface AppointmentEventRow {
  id: string;
  event_type: AppointmentEventType;
  actor_type: ActorType;
  actor_user_id: string | null;
  detail: Record<string, unknown>;
  created_at: Date;
}

/** NON-CANCELLED appointments of one professional whose blocked window overlaps [from, until)
 *  — completed and no-show included. A past walk-in («ya se realizó») is refused, and the
 *  agenda shows these, when the list is not empty; nothing here writes. */
export async function listStaffAppointmentsOverlapping(
  tenantId: string,
  siteId: string,
  staffId: string,
  from: Date,
  until: Date,
  client?: PoolClient,
): Promise<Array<{ id: string; start_at: Date; service_end_at: Date; status: string; service_name: string; customer_name: string | null }>> {
  const run = <R extends QueryResultRow>(text: string, params: unknown[]) => (client ? client.query<R>(text, params) : query<R>(text, params));
  const r = await run<{ id: string; start_at: Date; service_end_at: Date; status: string; service_name: string; customer_name: string | null }>(
    `SELECT a.id, a.start_at, a.service_end_at, a.status, a.service_name_snapshot AS service_name,
            COALESCE(c.name, a.guest_name) AS customer_name
       FROM appointments a
       LEFT JOIN contacts c ON c.id = a.contact_id AND c.tenant_id = a.tenant_id
      WHERE a.tenant_id = $1 AND a.site_id = $2 AND a.staff_id = $3 AND a.status <> 'cancelled'
        AND a.blocked_until > $4 AND a.blocked_from < $5
      ORDER BY a.start_at`,
    [tenantId, siteId, staffId, from, until],
  );
  return r.rows;
}

export async function listAppointmentEvents(tenantId: string, appointmentId: string): Promise<AppointmentEventRow[]> {
  const r = await query<AppointmentEventRow>(
    `SELECT id, event_type, actor_type, actor_user_id, detail, created_at
       FROM appointment_events WHERE tenant_id = $1 AND appointment_id = $2 ORDER BY created_at ASC`,
    [tenantId, appointmentId],
  );
  return r.rows;
}

/** Appointments for a contact (contact detail view) — READ-SIDE DEFENDED by
 * client: both filters are passed, so a mislinked cross-client appointment
 * never surfaces on another client's contact. FAILS CLOSED at runtime: the
 * TypeScript signature requires clientId, but an untyped JS caller could omit
 * it — and listAppointments treats a missing clientId as "no filter" (tenant-
 * wide). A missing/empty clientId therefore returns [] instead of widening. */
export async function listAppointmentsForContact(
  tenantId: string,
  contactId: string,
  clientId: string,
): Promise<AppointmentListItem[]> {
  if (!clientId || typeof clientId !== 'string') return [];
  return listAppointments(tenantId, { contactId, clientId });
}

/** All appointment events across a contact's appointments — the Activity tab.
 * Client-defended like the appointment list: the owning appointment must belong
 * to `clientId` in addition to the tenant/contact filters. */
export async function listEventsForContact(
  tenantId: string,
  contactId: string,
  clientId: string,
): Promise<Array<AppointmentEventRow & { appointment_id: string }>> {
  // Fail closed on a runtime-missing clientId (the SQL's a.client_id = $3 would
  // match nothing on NULL anyway; this makes the contract explicit).
  if (!clientId || typeof clientId !== 'string') return [];
  const r = await query<AppointmentEventRow & { appointment_id: string }>(
    `SELECT e.id, e.appointment_id, e.event_type, e.actor_type, e.actor_user_id, e.detail, e.created_at
       FROM appointment_events e
       JOIN appointments a ON a.id = e.appointment_id
      WHERE e.tenant_id = $1 AND a.contact_id = $2 AND a.client_id = $3
      ORDER BY e.created_at DESC
      LIMIT 200`,
    [tenantId, contactId, clientId],
  );
  return r.rows;
}

/**
 * A contact's COMMERCIAL profile — what they are worth, and how they behave.
 *
 * Feeds the record page's "Valor del cliente" card and its "Preferencias" card
 * (docs/ui-redesign-crm-inbox.md — artboard 23a). Every field is DERIVED from
 * appointments this contact actually completed; nothing here is stored, so nothing can
 * go stale against the appointments it describes.
 *
 * ONE query with three CTEs rather than three round-trips, because the card renders as a
 * single block and a partially-loaded "$1.240.000 in — citas" is worse than a spinner.
 *
 * `price_snapshot` is the price AS BOOKED, not the service's price today — which is the
 * whole reason the snapshot column exists. A shop that raises its prices must not have
 * every past visit silently revalued.
 */
export interface ContactValueProfile {
  /** Sum of price_snapshot over COMPLETED appointments. Null when none have a price. */
  lifetime_value: string | null;
  /** Completed appointments — the "en N citas" beside the money. */
  completed_count: number;
  /** lifetime_value / completed_count, or null when there is nothing to average. */
  average_ticket: string | null;
  /**
   * Where this contact's lifetime value ranks among the client's OTHER CUSTOMERS —
   * 8 means "top 8%". Null when the comparison would not mean anything.
   *
   * The cohort is contacts with AT LEAST ONE completed appointment, not every contact.
   * Including leads with zero spend would put anyone who has ever paid in the top few
   * percent, which is a flattering number that tells an operator nothing.
   *
   * It is also null below MIN_PERCENTILE_COHORT customers. A percentile over three
   * people is arithmetic, not information: two tied customers out of two came back as
   * "top 1%", which reads as a precise claim about a shop that has served two people.
   * Better to show nothing than a number that will embarrass the product.
   */
  value_percentile: number | null;
  /** The staff member with the most completed appointments — their "usual barber". */
  usual_staff_name: string | null;
  /** The most-booked service name, from the same snapshots. */
  usual_service_name: string | null;
  /**
   * Mean days between consecutive completed visits — the "cada N días" frequency.
   * Null with fewer than two visits, because one visit establishes no rhythm.
   */
  avg_days_between_visits: number | null;
}

/**
 * How many paying customers a client needs before "Top N%" is worth printing.
 *
 * 10 is the point where one position is ~10 percentage points, so the number moves in
 * steps a person can reason about. Below it the rank is dominated by who happens to have
 * booked, and the design's own example ("Top 8%") is not even expressible.
 */
const MIN_PERCENTILE_COHORT = 10;

export async function getContactValueProfile(
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<ContactValueProfile | null> {
  const r = await query<ContactValueProfile>(
    `WITH mine AS (
       SELECT price_snapshot, staff_id, service_name_snapshot, start_at
         FROM appointments
        WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3 AND status = 'completed'
     ),
     agg AS (
       SELECT SUM(price_snapshot) AS lifetime_value,
              COUNT(*)::int       AS completed_count,
              AVG(price_snapshot) AS average_ticket,
              mode() WITHIN GROUP (ORDER BY staff_id)              AS usual_staff_id,
              mode() WITHIN GROUP (ORDER BY service_name_snapshot) AS usual_service_name,
              -- Mean gap between consecutive visits: the span from first to last divided
              -- by the number of GAPS (n-1), which is what "cada N días" means. Dividing
              -- by n would understate the rhythm by a whole interval.
              CASE WHEN COUNT(*) > 1
                   THEN EXTRACT(EPOCH FROM (MAX(start_at) - MIN(start_at)))
                        / 86400.0 / (COUNT(*) - 1)
              END AS avg_days_between_visits
         FROM mine
     ),
     cohort AS (
       -- Every OTHER customer of this client, by lifetime value. Restricted to contacts
       -- with a completed appointment — see the note on value_percentile.
       SELECT contact_id, SUM(price_snapshot) AS lv
         FROM appointments
        WHERE tenant_id = $1 AND client_id = $2 AND contact_id IS NOT NULL
              AND status = 'completed'
        GROUP BY contact_id
       HAVING SUM(price_snapshot) IS NOT NULL
     )
     SELECT agg.lifetime_value::text,
            agg.completed_count,
            round(agg.average_ticket)::text AS average_ticket,
            -- The share of the cohort that this contact OUTRANKS, inverted into a
            -- "top N%", and only once the cohort is big enough for a percentage to carry
            -- information at all (see MIN_PERCENTILE_COHORT).
            CASE WHEN (SELECT count(*) FROM cohort) >= $4
                 THEN GREATEST(1, round(
                        100.0 * (SELECT count(*) FROM cohort c WHERE c.lv > (SELECT lv FROM cohort WHERE contact_id = $3))
                        / (SELECT count(*) FROM cohort)
                      ))::int
            END AS value_percentile,
            s.name AS usual_staff_name,
            agg.usual_service_name,
            round(agg.avg_days_between_visits)::int AS avg_days_between_visits
       FROM agg
       LEFT JOIN staff s ON s.id = agg.usual_staff_id AND s.tenant_id = $1`,
    [tenantId, clientId, contactId, MIN_PERCENTILE_COHORT],
  );
  const row = r.rows[0];
  // COUNT(*) over an empty set still returns a row, with 0 and nulls throughout — that
  // is a contact who has never completed a visit, which the card renders as its empty
  // state rather than as "$0".
  return row && row.completed_count > 0 ? row : null;
}
