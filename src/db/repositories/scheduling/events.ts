import type { PoolClient } from 'pg';
import { query } from '../../client.js';

/**
 * scheduling_events repository — the append-only realtime feed the poll endpoints
 * read. Domain mutations record an event AFTER commit (or inside the txn client
 * when appended as part of it). event_type mirrors the WS-style contract even
 * though delivery is by polling.
 */

export type SchedulingEventType =
  | 'appointment.created'
  | 'appointment.rescheduled'
  | 'appointment.cancelled'
  | 'appointment.status_changed'
  | 'schedule.changed';

export interface SchedulingEventRow {
  seq: string; // bigint → string
  id: string;
  tenant_id: string;
  client_id: string | null;
  site_id: string | null;
  event_type: SchedulingEventType;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** Record an event. Runs on the txn client if given (same commit), else the pool. */
export async function recordSchedulingEvent(
  input: {
    tenantId: string;
    clientId?: string | null;
    siteId: string | null;
    eventType: SchedulingEventType;
    payload: Record<string, unknown>;
  },
  client?: PoolClient,
): Promise<void> {
  const run = (text: string, params: unknown[]) =>
    client ? client.query(text, params) : query(text, params);
  await run(
    `INSERT INTO scheduling_events (tenant_id, client_id, site_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)`,
    [input.tenantId, input.clientId ?? null, input.siteId, input.eventType, JSON.stringify(input.payload)],
  );
}

/** Events for a tenant after a cursor (seq). Optionally filtered by site/client. */
export async function listEventsSince(
  tenantId: string,
  sinceSeq: string | null,
  opts: { siteId?: string; clientId?: string | null; limit?: number } = {},
): Promise<SchedulingEventRow[]> {
  const params: unknown[] = [tenantId, sinceSeq ?? '0'];
  const where = ['tenant_id = $1', 'seq > $2'];
  if (opts.clientId) {
    params.push(opts.clientId);
    where.push(`client_id = $${params.length}`);
  }
  if (opts.siteId) {
    params.push(opts.siteId);
    where.push(`site_id = $${params.length}`);
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  const r = await query<SchedulingEventRow>(
    `SELECT * FROM scheduling_events WHERE ${where.join(' AND ')} ORDER BY seq ASC LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

/** The current max seq for a tenant — the cursor a client starts polling from. */
export async function latestEventSeq(tenantId: string): Promise<string | null> {
  const r = await query<{ seq: string }>(
    `SELECT COALESCE(MAX(seq), 0)::text AS seq FROM scheduling_events WHERE tenant_id = $1`,
    [tenantId],
  );
  return r.rows[0]?.seq ?? '0';
}
