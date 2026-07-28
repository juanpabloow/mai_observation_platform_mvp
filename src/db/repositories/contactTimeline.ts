import { query } from '../client.js';

/**
 * READ-ONLY unified contact timeline. Combines FIVE sources WITHOUT copying their
 * data: crm_activity_events (meta events only), notes, tasks, appointments, and
 * conversations — each normalized to ContactTimelineItem. Cursor-based (keyset on
 * occurred_at + a stable id), descending, safe limit, ALWAYS scoped by tenant_id +
 * client_id + contact_id.
 *
 * De-dup: a note/task is shown as its OWN item (note/task), so the note and task
 * audit events are NOT also emitted here — the "crm" source is only the meta events
 * that have no standalone entity (tag_added/removed, owner_changed, stage_changed).
 * Appointments/conversations are filtered to THIS client (a.client_id / the canonical
 * workflow→client lateral) so a mislinked record of another client never appears.
 * Full conversation text is never stored in events and never read into the timeline.
 */

export type TimelineSourceType = 'crm' | 'note' | 'task' | 'appointment' | 'conversation';

export interface ContactTimelineItem {
  id: string;
  type: string;
  occurredAt: Date;
  title: string;
  summary: string | null;
  actorName: string | null;
  sourceId: string;
  sourceType: TimelineSourceType;
}

export interface TimelinePage {
  items: ContactTimelineItem[];
  nextCursor: string | null;
}

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 25;

interface RawRow {
  sort_id: string;
  type: string;
  occurred_at: Date;
  title: string;
  summary: string | null;
  actor_name: string | null;
  source_id: string;
  source_type: TimelineSourceType;
}

/** cursor = base64("<iso>|<sortId>"). Opaque to callers. */
function encodeCursor(occurredAt: Date, sortId: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${sortId}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | null | undefined): { ts: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    const ts = new Date(iso);
    if (!id || Number.isNaN(ts.getTime())) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

export async function getContactTimeline(
  tenantId: string,
  clientId: string,
  contactId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<TimelinePage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const cur = decodeCursor(opts.cursor);

  // $1 tenant, $2 client, $3 contact, $4 cursorTs (nullable), $5 cursorId (nullable), $6 limit+1
  const r = await query<RawRow>(
    `
    WITH unified AS (
      -- CRM meta events (no standalone entity): tags, owner, stage.
      SELECT e.id AS sort_id, e.event_type AS type, e.occurred_at,
             e.event_type AS title, NULL::text AS summary, u.name AS actor_name,
             e.id AS source_id, 'crm'::text AS source_type
        FROM crm_activity_events e
        LEFT JOIN "user" u ON u.id = e.actor_user_id
       WHERE e.tenant_id = $1 AND e.client_id = $2 AND e.contact_id = $3
         AND e.event_type IN ('tag_added', 'tag_removed', 'owner_changed', 'stage_changed')

      UNION ALL
      -- Notes (active only).
      SELECT n.id, 'note', n.created_at,
             'Note', left(n.body, 140), u.name,
             n.id, 'note'
        FROM contact_notes n
        LEFT JOIN "user" u ON u.id = n.created_by_user_id
       WHERE n.tenant_id = $1 AND n.client_id = $2 AND n.contact_id = $3 AND n.deleted_at IS NULL

      UNION ALL
      -- Tasks.
      SELECT t.id, 'task', t.created_at,
             t.title, t.status, u.name,
             t.id, 'task'
        FROM crm_tasks t
        LEFT JOIN "user" u ON u.id = t.assigned_to_user_id
       WHERE t.tenant_id = $1 AND t.client_id = $2 AND t.contact_id = $3

      UNION ALL
      -- Appointments (client-scoped via the denormalized client_id).
      SELECT a.id, 'appointment', a.start_at,
             a.service_name_snapshot, a.status, a.staff_name,
             a.id, 'appointment'
        FROM (
          SELECT ap.id, ap.start_at, ap.service_name_snapshot, ap.status, st.name AS staff_name
            FROM appointments ap
            LEFT JOIN staff st ON st.id = ap.staff_id AND st.tenant_id = ap.tenant_id
           WHERE ap.tenant_id = $1 AND ap.client_id = $2 AND ap.contact_id = $3
        ) a

      UNION ALL
      -- Conversations of THIS contact whose canonical workflow → this client.
      SELECT c.id, 'conversation', COALESCE(c.last_message_at, c.updated_at, c.created_at),
             c.conversation_ref, c.mode, NULL::text,
             c.id, 'conversation'
        FROM conversations c
        JOIN LATERAL (
          SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
            FROM workflows w
           WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
           ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
        ) cw ON cw.client_id = $2
       WHERE c.tenant_id = $1 AND c.contact_id = $3
    )
    SELECT * FROM unified
     WHERE ($4::timestamptz IS NULL OR (occurred_at, sort_id) < ($4::timestamptz, $5::uuid))
     ORDER BY occurred_at DESC, sort_id DESC
     LIMIT $6
    `,
    [tenantId, clientId, contactId, cur?.ts ?? null, cur?.id ?? null, limit + 1],
  );

  const rows = r.rows;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: ContactTimelineItem[] = page.map((row) => ({
    id: `${row.source_type}:${row.source_id}`,
    type: row.type,
    occurredAt: row.occurred_at,
    title: row.title,
    summary: row.summary,
    actorName: row.actor_name,
    sourceId: row.source_id,
    sourceType: row.source_type,
  }));
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurred_at, last.sort_id) : null;
  return { items, nextCursor };
}
