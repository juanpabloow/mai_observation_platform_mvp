import type { PoolClient, QueryResultRow } from 'pg';
import { query, firstRowOrThrow } from '../../client.js';

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
        tenant_id, site_id, contact_id, source_conversation_id, staff_id, service_id,
        start_at, service_end_at, blocked_from, blocked_until,
        service_name_snapshot, duration_min_snapshot, price_snapshot,
        buffer_before_min_snapshot, buffer_after_min_snapshot,
        status, origin, created_by_type, created_by_user_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'scheduled',$16,$17,$18,$19)
     RETURNING *`,
    [
      input.tenantId, input.siteId, input.contactId, input.sourceConversationId, input.staffId, input.serviceId,
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
  siteId?: string;
  staffId?: string;
  status?: AppointmentStatus | AppointmentStatus[];
  contactId?: string;
  conversationId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface AppointmentListItem extends AppointmentRow {
  staff_name: string | null;
  site_name: string | null;
  contact_name: string | null;
}

/** Tenant-scoped list with safe filters + light joins for display. */
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
  if (filters.siteId) add((i) => `a.site_id = $${i}`, filters.siteId);
  if (filters.staffId) add((i) => `a.staff_id = $${i}`, filters.staffId);
  if (filters.contactId) add((i) => `a.contact_id = $${i}`, filters.contactId);
  if (filters.conversationId) add((i) => `a.source_conversation_id = $${i}`, filters.conversationId);
  if (filters.status) {
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
    add((i) => `a.status = ANY($${i}::text[])`, arr);
  }
  if (filters.from) add((i) => `a.start_at >= $${i}`, filters.from);
  if (filters.to) add((i) => `a.start_at < $${i}`, filters.to);
  params.push(Math.min(filters.limit ?? 500, 1000));
  const r = await query<AppointmentListItem>(
    `SELECT a.*, st.name AS staff_name, si.name AS site_name, ct.name AS contact_name
       FROM appointments a
       LEFT JOIN staff st ON st.id = a.staff_id
       LEFT JOIN sites si ON si.id = a.site_id
       LEFT JOIN contacts ct ON ct.id = a.contact_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.start_at ASC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
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

/** Appointments for a contact (contact detail view). */
export async function listAppointmentsForContact(tenantId: string, contactId: string): Promise<AppointmentListItem[]> {
  return listAppointments(tenantId, { contactId });
}

/** All appointment events across a contact's appointments — the Activity tab. */
export async function listEventsForContact(
  tenantId: string,
  contactId: string,
): Promise<Array<AppointmentEventRow & { appointment_id: string }>> {
  const r = await query<AppointmentEventRow & { appointment_id: string }>(
    `SELECT e.id, e.appointment_id, e.event_type, e.actor_type, e.actor_user_id, e.detail, e.created_at
       FROM appointment_events e
       JOIN appointments a ON a.id = e.appointment_id
      WHERE e.tenant_id = $1 AND a.contact_id = $2
      ORDER BY e.created_at DESC
      LIMIT 200`,
    [tenantId, contactId],
  );
  return r.rows;
}
