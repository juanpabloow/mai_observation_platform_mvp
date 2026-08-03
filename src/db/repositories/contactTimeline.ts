import { query } from '../client.js';

/**
 * READ-ONLY unified contact timeline (C-3). Unions FOUR sources — NONE copied into a
 * log; each is read from its own table at read time and normalized to one shape:
 *   - conversation : ONE entry per conversation (last-message excerpt + message COUNT),
 *                    never one entry per message.
 *   - appointment  : one entry PER appointment_event (created/rescheduled/cancelled/
 *                    confirmed/completed) — faithful history, not just current state.
 *   - note         : contact_notes (active), body excerpt (note_* audit events are NOT
 *                    read here, so a note is never shown twice).
 *   - activity     : crm_activity_events EXCEPT note_* — task_*, tag_*, owner_changed,
 *                    stage_changed, contact_merged, consent_changed (CRM-native facts).
 *
 * DATA not prose: an item is { id, kind, occurred_at, actor, title_key, summary, ref,
 * meta } — no user-facing sentences (C-4 renders + translates the copy).
 *
 * SCALABILITY (the careful part):
 *  - KEYSET on (occurred_at DESC, id DESC), never OFFSET. The cursor carries FULL
 *    microsecond precision (to_char … .US), so two entries from different sources that
 *    share a timestamp to the microsecond page cleanly (the C-1 lesson).
 *  - PER-SOURCE LIMIT: each source fetches limit+1 in its OWN subquery (its own
 *    ORDER BY + LIMIT), so one very active source can't starve the others; the outer
 *    merges + slices. Work per page is bounded to (#sources × (limit+1)).
 *  - `kinds` PUSHES DOWN: only requested sources are unioned — a notes-only request
 *    issues no conversation/appointment/activity query at all.
 *  - Every source is index-served for (contact_id, occurred_at DESC) with tenant+client
 *    predicates (see the C-3 migration indexes).
 */

export type TimelineSource = 'conversation' | 'appointment' | 'note' | 'activity';
export type TimelineActor = 'user' | 'bot' | 'customer' | 'system' | 'automation';
const ALL_SOURCES: TimelineSource[] = ['conversation', 'appointment', 'note', 'activity'];

export interface TimelineItem {
  id: string;
  /** Specific event key (translation key), e.g. 'conversation', 'appointment_completed',
   *  'note', 'task_created', 'tag_added', 'owner_changed'. */
  kind: string;
  occurred_at: string; // microsecond-precise ISO (UTC)
  actor: TimelineActor;
  title_key: string;
  summary: string | null;
  ref: Record<string, unknown>;
  meta: Record<string, unknown>;
}
export interface TimelinePage {
  items: TimelineItem[];
  nextCursor: string | null;
}

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 25;

function encodeCursor(occurredUs: string, sortId: string): string {
  return Buffer.from(`${occurredUs}|${sortId}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | null | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    const i = s.indexOf('|');
    if (i <= 0) return null;
    const ts = s.slice(0, i);
    const id = s.slice(i + 1);
    if (Number.isNaN(new Date(ts).getTime())) return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

// Reused keyset predicate. $4 = cursor ts (microsecond text ::timestamptz, nullable),
// $5 = cursor id (::uuid). Each subquery substitutes its own (occurred, id) expression.
const keyset = (occurredExpr: string, idExpr: string) =>
  `($4::timestamptz IS NULL OR (${occurredExpr}, ${idExpr}) < ($4::timestamptz, $5::uuid))`;

/** Each source projects the SAME 8 columns so they UNION cleanly. */
const SUBQUERY: Record<TimelineSource, string> = {
  conversation: `
    SELECT c.id AS sort_id,
           COALESCE(c.last_message_at, c.updated_at, c.created_at) AS occurred_at,
           'conversation' AS kind, 'customer' AS actor,
           lm.text AS summary, NULL::text AS actor_name,
           jsonb_build_object('conversationId', c.id, 'conversationRef', c.conversation_ref, 'workflowRef', c.n8n_workflow_id) AS ref,
           jsonb_build_object('mode', c.mode, 'messageCount', (SELECT count(*) FROM handoff_messages hm WHERE hm.conversation_id = c.id)) AS meta
      FROM conversations c
      JOIN LATERAL (
        SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
          FROM workflows w
         WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
         ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
      ) cw ON cw.client_id = $2
      LEFT JOIN LATERAL (
        SELECT hm.text FROM handoff_messages hm WHERE hm.conversation_id = c.id ORDER BY hm.occurred_at DESC LIMIT 1
      ) lm ON true
     WHERE c.tenant_id = $1 AND c.contact_id = $3
       AND ${keyset('COALESCE(c.last_message_at, c.updated_at, c.created_at)', 'c.id')}
     ORDER BY occurred_at DESC, c.id DESC
     LIMIT $6`,
  appointment: `
    SELECT ae.id AS sort_id, ae.created_at AS occurred_at,
           ae.event_type AS kind,
           CASE ae.actor_type WHEN 'agent' THEN 'user' WHEN 'public' THEN 'customer' ELSE 'system' END AS actor,
           ap.service_name_snapshot AS summary, st.name AS actor_name,
           jsonb_build_object('appointmentId', ap.id, 'publicReference', ap.public_reference) AS ref,
           jsonb_build_object('status', ap.status, 'staffName', st.name, 'startAt', ap.start_at, 'detail', ae.detail) AS meta
      FROM appointment_events ae
      JOIN appointments ap ON ap.id = ae.appointment_id AND ap.tenant_id = ae.tenant_id
      LEFT JOIN staff st ON st.id = ap.staff_id AND st.tenant_id = ap.tenant_id
     WHERE ae.tenant_id = $1 AND ap.client_id = $2 AND ap.contact_id = $3
       AND ae.event_type LIKE 'appointment_%'
       AND ${keyset('ae.created_at', 'ae.id')}
     ORDER BY ae.created_at DESC, ae.id DESC
     LIMIT $6`,
  note: `
    SELECT n.id AS sort_id, n.created_at AS occurred_at, 'note' AS kind,
           CASE WHEN n.author_kind = 'automation' THEN 'automation'
                WHEN n.created_by_user_id IS NOT NULL THEN 'user' ELSE 'system' END AS actor,
           left(n.body, 280) AS summary, u.name AS actor_name,
           jsonb_build_object('noteId', n.id) AS ref,
           jsonb_build_object('edited', (n.updated_at > n.created_at)) AS meta
      FROM contact_notes n
      LEFT JOIN "user" u ON u.id = n.created_by_user_id
     WHERE n.tenant_id = $1 AND n.client_id = $2 AND n.contact_id = $3 AND n.deleted_at IS NULL
       AND ${keyset('n.created_at', 'n.id')}
     ORDER BY n.created_at DESC, n.id DESC
     LIMIT $6`,
  activity: `
    SELECT e.id AS sort_id, e.occurred_at AS occurred_at, e.event_type AS kind,
           CASE WHEN e.actor_kind = 'automation' THEN 'automation'
                WHEN e.actor_user_id IS NOT NULL THEN 'user' ELSE 'system' END AS actor,
           NULL::text AS summary, u.name AS actor_name,
           jsonb_build_object('eventId', e.id) AS ref,
           e.detail AS meta
      FROM crm_activity_events e
      LEFT JOIN "user" u ON u.id = e.actor_user_id
     WHERE e.tenant_id = $1 AND e.client_id = $2 AND e.contact_id = $3
       AND e.event_type NOT LIKE 'note_%'
       AND ${keyset('e.occurred_at', 'e.id')}
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT $6`,
};

interface RawRow {
  sort_id: string;
  occurred_us: string;
  kind: string;
  actor: TimelineActor;
  summary: string | null;
  actor_name: string | null;
  ref: Record<string, unknown>;
  meta: Record<string, unknown>;
}

export async function getContactTimeline(
  tenantId: string,
  clientId: string,
  contactId: string,
  opts: { limit?: number; cursor?: string | null; kinds?: TimelineSource[] } = {},
): Promise<TimelinePage> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const cur = decodeCursor(opts.cursor);
  const requested = opts.kinds && opts.kinds.length > 0 ? ALL_SOURCES.filter((s) => opts.kinds!.includes(s)) : ALL_SOURCES;
  if (requested.length === 0) return { items: [], nextCursor: null };

  // Only the requested source subqueries are issued (push-down).
  const union = requested.map((s) => `(${SUBQUERY[s]})`).join('\n    UNION ALL\n');
  const sql = `
    SELECT sort_id, kind, actor, summary, actor_name, ref, meta,
           to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_us
      FROM (${union}) u
     ORDER BY u.occurred_at DESC, u.sort_id DESC
     LIMIT $6`;

  const r = await query<RawRow>(sql, [tenantId, clientId, contactId, cur?.ts ?? null, cur?.id ?? null, limit + 1]);
  const hasMore = r.rows.length > limit;
  const page = hasMore ? r.rows.slice(0, limit) : r.rows;
  const items: TimelineItem[] = page.map((row) => ({
    id: `${row.kind}:${row.sort_id}`,
    kind: row.kind,
    occurred_at: row.occurred_us,
    actor: row.actor,
    title_key: row.kind,
    summary: row.summary,
    ref: { ...(row.ref ?? {}) },
    meta: { ...(row.meta ?? {}), actorName: row.actor_name },
  }));
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurred_us, last.sort_id) : null;
  return { items, nextCursor };
}
