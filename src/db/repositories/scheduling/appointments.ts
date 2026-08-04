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
  | 'escalation';

export interface AppointmentRow {
  id: string;
  public_reference: string;
  tenant_id: string;
  client_id: string;
  site_id: string;
  contact_id: string | null;
  source_conversation_id: string | null;
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
        status, origin, created_by_type, created_by_user_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'scheduled',$17,$18,$19,$20)
     RETURNING *`,
    [
      input.tenantId, input.clientId, input.siteId, input.contactId, input.sourceConversationId, input.staffId, input.serviceId,
      input.startAt, input.serviceEndAt, input.blockedFrom, input.blockedUntil,
      input.serviceNameSnapshot, input.durationMinSnapshot, input.priceSnapshot,
      input.bufferBeforeMinSnapshot, input.bufferAfterMinSnapshot,
      input.origin, input.createdByType, input.createdByUserId, input.idempotencyKey,
    ],
  );
  return firstRowOrThrow(r, 'insertAppointment');
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
   *  never a per-row lookup. NULL for walk-ins / a contact with no phone/email. */
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

/** A contact's active appointment described in words an agent/customer can read back:
 *  local day + time (in the appointment's OWN site tz) + service name. */
export interface ActiveAppointmentView {
  id: string;
  day: string; // YYYY-MM-DD (site-local)
  time: string; // HH:MM (site-local, 24h)
  service: string;
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
