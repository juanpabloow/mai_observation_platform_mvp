import type { PoolClient } from 'pg';
import { query } from '../client.js';
import { normalizeE164 } from '../../scheduling/phone.js';

/**
 * CRM repository for the canonical PERSON entity (contacts) and the
 * conversation↔contact link. Every function is tenant-scoped. resolveOrCreate is
 * the race-safe chokepoint the scheduling API uses to attach a booking to a person.
 *
 * "Is a customer" is DERIVED, never stored: a contact with ≥1 completed
 * appointment. listContacts / getContact compute it in SQL.
 */

export type BotHumanMode = 'bot' | 'human';
export type ContactStage = 'new' | 'active' | 'customer' | 'archived';
export type MessagingConsent = 'unknown' | 'opted_in' | 'opted_out';

export interface ContactRow {
  id: string;
  tenant_id: string;
  client_id: string;
  /** SOURCE (C-2): how the contact first arrived — descriptive, never a unique key. */
  channel: string;
  channel_user_id: string;
  phone_e164: string | null;
  name: string | null;
  email: string | null;
  bot_human_mode: BotHumanMode;
  stage: ContactStage;
  assigned_to: string | null;
  /** Consent is STORE-ONLY (C-2): recorded, never gates service replies. */
  messaging_consent: MessagingConsent;
  consent_updated_at: Date | null;
  consent_source: string | null;
  custom_fields: Record<string, unknown>;
  first_contact_at: Date;
  last_contact_at: Date;
  message_count: number;
  created_at: Date;
  updated_at: Date;
}

// resolveOrCreateContact was removed in C-2: contact resolution now goes through the
// identity spine — see resolveContactByIdentity in ./contactIdentities.ts (the single
// chokepoint). The old ON CONFLICT keyed on (channel, channel_user_id), a unique that
// C-2 dropped.

/** Get a contact by id, tenant-scoped. When clientId is provided (a member), the
 * contact must belong to that client too — else null (no cross-client read). */
export async function getContactById(
  tenantId: string,
  id: string,
  clientId?: string | null,
): Promise<ContactRow | null> {
  const params: unknown[] = [id, tenantId];
  let where = 'id = $1 AND tenant_id = $2';
  if (clientId) {
    params.push(clientId);
    where += ` AND client_id = $${params.length}`;
  }
  const r = await query<ContactRow>(`SELECT * FROM contacts WHERE ${where}`, params);
  return r.rows[0] ?? null;
}

export interface ContactListItem extends ContactRow {
  is_customer: boolean;
  completed_count: number;
  next_appointment_at: Date | null;
  last_conversation_at: Date | null;
  visit_count: number;
  /** Open (not completed/cancelled) tasks on this contact. */
  open_task_count: number;
  /** Of those, the ones whose due_at is in the past. */
  overdue_task_count: number;
}

/** The Tasks facet on the contacts list. */
export type ContactTaskFilter = 'open' | 'overdue';

/** Sentinel owner value meaning "no owner assigned" (a real filter, not a user id). */
export const UNASSIGNED_OWNER = 'unassigned';

/**
 * Compact counters for the contacts list summary strip. ONE grouped query over
 * the same client-scoped set the list pages through — never a per-row lookup and
 * never a second round-trip per metric.
 */
export interface ContactsSummary {
  total: number;
  new: number;
  active: number;
  customer: number;
  overdueTasks: number;
  unassigned: number;
}

export interface ListContactsResult {
  items: ContactListItem[];
  /** Opaque keyset cursor for the NEXT page, or null when this is the last page. */
  nextCursor: string | null;
}

/**
 * Immutable "search document" expression (aliased to `c`). MUST stay byte-identical
 * to the GIN trigram index in migrations/1782500000000_contacts-search.ts (minus the
 * `c.` alias) or the planner won't use it. Includes a digits-only copy of the phone
 * so a phone typed with +/spaces/dashes still matches the stored E.164.
 */
const CONTACT_SEARCH_DOC =
  `lower(coalesce(c.name,'') || ' ' || coalesce(c.email,'') || ' ' || coalesce(c.channel_user_id,'') || ' ' || coalesce(c.phone_e164,'') || ' ' || regexp_replace(coalesce(c.phone_e164,''), '[^0-9]', '', 'g'))`;

/** Keyset cursor codec: opaque base64url of `<micro-precise ISO ts>|<id>`. The
 * timestamp MUST carry Postgres's microsecond precision — a JS Date only has
 * millisecond precision, and a ms-truncated cursor makes the keyset comparison SKIP
 * every row that shares a millisecond with the cursor row. So the ts is taken from the
 * DB as text (to_char … .US) in the query, never from the row's Date. */
function encodeContactCursor(cursorTs: string, id: string): string {
  return Buffer.from(`${cursorTs}|${id}`, 'utf8').toString('base64url');
}
function decodeContactCursor(cursor: string | null | undefined): { ts: string; id: string } | null {
  if (!cursor) return null;
  try {
    const s = Buffer.from(cursor, 'base64url').toString('utf8');
    const i = s.indexOf('|');
    if (i <= 0) return null;
    const ts = s.slice(0, i);
    const id = s.slice(i + 1);
    // Reject a malformed cursor rather than letting it 500 on a bad cast.
    if (Number.isNaN(new Date(ts).getTime())) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { ts, id };
  } catch {
    return null;
  }
}

/**
 * Contact list with derived customer status, next upcoming appointment, visits
 * (completed appts), and last conversation activity. Tenant-scoped.
 *
 * Search is index-served (pg_trgm GIN over CONTACT_SEARCH_DOC): one substring match
 * across name/email/channel_user_id/phone, and a phone typed with any punctuation
 * matches the stored E.164 via the digits-only token. Pagination is KEYSET on
 * (last_contact_at DESC, id DESC) — stable under the constantly-changing
 * last_contact_at (offset pagination would skip/duplicate rows as contacts reorder),
 * and index-served by contacts_client_recency_idx. Fetches pageSize+1 to know whether
 * a next page exists.
 */
export async function listContacts(
  tenantId: string,
  opts: {
    search?: string;
    stage?: ContactStage;
    /** Owner filter: a user id, or 'unassigned' for contacts with no owner. */
    owner?: string;
    /** Task filter: contacts with ≥1 open task, or ≥1 OVERDUE open task. */
    tasks?: ContactTaskFilter;
    limit?: number;
    clientId?: string | null;
    /** Opaque cursor from a previous result's nextCursor. Malformed → ignored. */
    cursor?: string | null;
  } = {},
): Promise<ListContactsResult> {
  const pageSize = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [tenantId];
  const where: string[] = ['c.tenant_id = $1'];
  if (opts.clientId) {
    params.push(opts.clientId);
    where.push(`c.client_id = $${params.length}`);
  }
  if (opts.stage) {
    params.push(opts.stage);
    where.push(`c.stage = $${params.length}`);
  }
  // Owner: a concrete user, or the "nobody owns this" bucket. Both are plain
  // predicates on the already client-scoped contacts row (no extra join).
  if (opts.owner === UNASSIGNED_OWNER) {
    where.push('c.assigned_to IS NULL');
  } else if (opts.owner) {
    params.push(opts.owner);
    where.push(`c.assigned_to = $${params.length}`);
  }
  // Tasks: served by the `t` aggregate below (open counts per contact), which is
  // index-backed by crm_tasks_contact_idx / crm_tasks_open_due_idx.
  if (opts.tasks === 'open') {
    where.push('COALESCE(t.open_count, 0) > 0');
  } else if (opts.tasks === 'overdue') {
    where.push('COALESCE(t.overdue_count, 0) > 0');
  }
  const search = opts.search?.trim();
  if (search) {
    params.push(`%${search}%`);
    const clauses = [`${CONTACT_SEARCH_DOC} ILIKE $${params.length}`];
    // When the user typed punctuation (e.g. "+57 300-123"), also match the
    // digits-only phone token so it finds the stored E.164.
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 2 && digits !== search) {
      params.push(`%${digits}%`);
      clauses.push(`${CONTACT_SEARCH_DOC} ILIKE $${params.length}`);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  const cursor = decodeContactCursor(opts.cursor);
  if (cursor) {
    params.push(cursor.ts);
    const tsIdx = params.length;
    params.push(cursor.id);
    where.push(`(c.last_contact_at, c.id) < ($${tsIdx}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(pageSize + 1);
  const limitIdx = params.length;
  // READ-SIDE CLIENT DEFENSE on the aggregates: appointment counts join on
  // contact_id AND client_id (a mislinked cross-client appointment never counts),
  // and last_conversation_at only considers conversations whose CANONICAL
  // workflow (most recently synced row for tenant + n8n_workflow_id) belongs to
  // the contact's own client.
  const r = await query<ContactListItem & { cursor_ts: string }>(
    `SELECT c.*,
            COALESCE(a.completed_count, 0) AS completed_count,
            (COALESCE(a.completed_count, 0) > 0) AS is_customer,
            COALESCE(a.completed_count, 0) AS visit_count,
            a.next_appointment_at,
            COALESCE(t.open_count, 0)::int AS open_task_count,
            COALESCE(t.overdue_count, 0)::int AS overdue_task_count,
            conv.last_conversation_at,
            -- Microsecond-precise cursor key (a JS Date would drop precision; see codec).
            to_char(c.last_contact_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
       FROM contacts c
       LEFT JOIN (
         SELECT contact_id, client_id,
                (COUNT(*) FILTER (WHERE status = 'completed'))::int AS completed_count,
                MIN(start_at) FILTER (WHERE status IN ('scheduled','confirmed') AND start_at >= now()) AS next_appointment_at
           FROM appointments
          WHERE tenant_id = $1 AND contact_id IS NOT NULL
          GROUP BY contact_id, client_id
       ) a ON a.contact_id = c.id AND a.client_id = c.client_id
       -- OPEN TASKS (the list column + the Tasks filter). ONE grouped aggregate,
       -- never a per-row lookup, and client-scoped on both sides of the join so a
       -- mislinked cross-client task can never be counted onto a contact.
       LEFT JOIN (
         SELECT contact_id, client_id,
                COUNT(*)::int AS open_count,
                (COUNT(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now()))::int AS overdue_count
           FROM crm_tasks
          WHERE tenant_id = $1 AND status = 'open'
          GROUP BY contact_id, client_id
       ) t ON t.contact_id = c.id AND t.client_id = c.client_id
       LEFT JOIN (
         SELECT co.contact_id, cw.client_id,
                MAX(COALESCE(co.last_message_at, co.updated_at)) AS last_conversation_at
           FROM conversations co
           JOIN LATERAL (
             SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
               FROM workflows w
              WHERE w.tenant_id = co.tenant_id AND w.n8n_workflow_id = co.n8n_workflow_id
              ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
           ) cw ON true
          WHERE co.tenant_id = $1 AND co.contact_id IS NOT NULL
          GROUP BY co.contact_id, cw.client_id
       ) conv ON conv.contact_id = c.id AND conv.client_id = c.client_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_contact_at DESC, c.id DESC
      LIMIT $${limitIdx}`,
    params,
  );
  const hasMore = r.rows.length > pageSize;
  const kept = hasMore ? r.rows.slice(0, pageSize) : r.rows;
  const last = kept[kept.length - 1];
  const nextCursor = hasMore && last ? encodeContactCursor(last.cursor_ts, last.id) : null;
  // `kept` rows carry the internal cursor_ts; it never reaches the client (the page
  // reads named fields), and `ContactListItem & {cursor_ts}` is assignable to the
  // ContactListItem[] contract.
  return { items: kept, nextCursor };
}

/**
 * The contacts-list summary counters, in ONE grouped query over the SAME
 * tenant+client scope (and the same search facet) the list itself uses — so the
 * strip can never disagree with the table, and adding it costs a single bounded
 * round-trip rather than one query per metric or an N+1 over the rows.
 *
 * NOTE the deliberate asymmetry: `total`/stage/owner counters describe the whole
 * FILTERED set (not just the current keyset page), which is what an operator
 * needs from a summary. `overdueTasks` counts CONTACTS carrying ≥1 overdue open
 * task, matching the row-level OVERDUE marker.
 */
export async function summarizeContacts(
  tenantId: string,
  opts: {
    search?: string;
    stage?: ContactStage;
    owner?: string;
    tasks?: ContactTaskFilter;
    clientId?: string | null;
  } = {},
): Promise<ContactsSummary> {
  const params: unknown[] = [tenantId];
  const where: string[] = ['c.tenant_id = $1'];
  if (opts.clientId) {
    params.push(opts.clientId);
    where.push(`c.client_id = $${params.length}`);
  }
  if (opts.stage) {
    params.push(opts.stage);
    where.push(`c.stage = $${params.length}`);
  }
  if (opts.owner === UNASSIGNED_OWNER) {
    where.push('c.assigned_to IS NULL');
  } else if (opts.owner) {
    params.push(opts.owner);
    where.push(`c.assigned_to = $${params.length}`);
  }
  if (opts.tasks === 'open') {
    where.push('COALESCE(t.open_count, 0) > 0');
  } else if (opts.tasks === 'overdue') {
    where.push('COALESCE(t.overdue_count, 0) > 0');
  }
  const search = opts.search?.trim();
  if (search) {
    params.push(`%${search}%`);
    const clauses = [`${CONTACT_SEARCH_DOC} ILIKE $${params.length}`];
    const digits = search.replace(/\D/g, '');
    if (digits.length >= 2 && digits !== search) {
      params.push(`%${digits}%`);
      clauses.push(`${CONTACT_SEARCH_DOC} ILIKE $${params.length}`);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  const r = await query<{
    total: string;
    new_count: string;
    active_count: string;
    customer_count: string;
    overdue_tasks: string;
    unassigned: string;
  }>(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE c.stage = 'new') AS new_count,
            COUNT(*) FILTER (WHERE c.stage = 'active') AS active_count,
            COUNT(*) FILTER (WHERE c.stage = 'customer') AS customer_count,
            COUNT(*) FILTER (WHERE COALESCE(t.overdue_count, 0) > 0) AS overdue_tasks,
            COUNT(*) FILTER (WHERE c.assigned_to IS NULL) AS unassigned
       FROM contacts c
       LEFT JOIN (
         SELECT contact_id, client_id,
                COUNT(*)::int AS open_count,
                (COUNT(*) FILTER (WHERE due_at IS NOT NULL AND due_at < now()))::int AS overdue_count
           FROM crm_tasks
          WHERE tenant_id = $1 AND status = 'open'
          GROUP BY contact_id, client_id
       ) t ON t.contact_id = c.id AND t.client_id = c.client_id
      WHERE ${where.join(' AND ')}`,
    params,
  );
  const row = r.rows[0];
  return {
    total: Number(row?.total ?? 0),
    new: Number(row?.new_count ?? 0),
    active: Number(row?.active_count ?? 0),
    customer: Number(row?.customer_count ?? 0),
    overdueTasks: Number(row?.overdue_tasks ?? 0),
    unassigned: Number(row?.unassigned ?? 0),
  };
}

/**
 * Conversations belonging to a contact (for the contact detail view), READ-SIDE
 * DEFENDED by client: only conversations whose CANONICAL workflow (same criterion
 * as the inbox's getConversationForClient — tenant + n8n_workflow_id, most
 * recently synced row wins) belongs to `clientId` are returned. The DB does not
 * guarantee conversations.contact_id stays within one client, so a mislinked
 * cross-client conversation must never surface on another client's contact.
 */
export async function listContactConversations(
  tenantId: string,
  contactId: string,
  clientId: string,
): Promise<Array<{ id: string; n8n_workflow_id: string; conversation_ref: string; mode: string; last_message_at: Date | null }>> {
  // Fail closed on a runtime-missing clientId (the join's cw.client_id = $3
  // would match nothing on NULL anyway; this makes the contract explicit).
  if (!clientId || typeof clientId !== 'string') return [];
  const r = await query(
    `SELECT c.id, c.n8n_workflow_id, c.conversation_ref, c.mode, c.last_message_at
       FROM conversations c
       JOIN LATERAL (
         SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
           FROM workflows w
          WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
          ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
       ) cw ON cw.client_id = $3
      WHERE c.tenant_id = $1 AND c.contact_id = $2
      ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC`,
    [tenantId, contactId, clientId],
  );
  return r.rows as Array<{ id: string; n8n_workflow_id: string; conversation_ref: string; mode: string; last_message_at: Date | null }>;
}

/** Attach a conversation to a contact (tenant-scoped, idempotent). */
export async function linkConversationToContact(
  tenantId: string,
  conversationId: string,
  contactId: string,
  client?: PoolClient,
): Promise<void> {
  const run = (text: string, params: unknown[]) =>
    client ? client.query(text, params) : query(text, params);
  await run(
    `UPDATE conversations SET contact_id = $3, updated_at = now()
      WHERE id = $2 AND tenant_id = $1 AND contact_id IS DISTINCT FROM $3`,
    [tenantId, conversationId, contactId],
  );
}

export interface UpdateContactInput {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  stage?: ContactStage;
  bot_human_mode?: BotHumanMode;
  assigned_to?: string | null;
  messaging_consent?: MessagingConsent;
  consent_source?: string | null;
  /** Full custom-fields blob — the caller MUST have validated it against the client's
   * field definitions first (see validateCustomFields). */
  custom_fields?: Record<string, unknown>;
}

export async function updateContact(
  tenantId: string,
  id: string,
  patch: UpdateContactInput,
  clientId?: string | null,
): Promise<ContactRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id, tenantId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.phone !== undefined) add('phone_e164', normalizeE164(patch.phone));
  if (patch.email !== undefined) add('email', patch.email);
  if (patch.stage !== undefined) add('stage', patch.stage);
  if (patch.bot_human_mode !== undefined) add('bot_human_mode', patch.bot_human_mode);
  if (patch.assigned_to !== undefined) add('assigned_to', patch.assigned_to);
  if (patch.messaging_consent !== undefined) {
    add('messaging_consent', patch.messaging_consent);
    sets.push('consent_updated_at = now()');
    // consent_source moves with the consent change (null clears it).
    add('consent_source', patch.consent_source ?? null);
  }
  if (patch.custom_fields !== undefined) {
    params.push(JSON.stringify(patch.custom_fields));
    sets.push(`custom_fields = $${params.length}::jsonb`);
  }
  if (sets.length === 0) return getContactById(tenantId, id, clientId);
  sets.push('updated_at = now()');
  let where = 'id = $1 AND tenant_id = $2';
  if (clientId) {
    params.push(clientId);
    where += ` AND client_id = $${params.length}`;
  }
  const r = await query<ContactRow>(
    `UPDATE contacts SET ${sets.join(', ')} WHERE ${where} RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}

/** Record messaging consent (STORE-ONLY — never gates anything). Client-aware so the
 * machine booking flow can set it inside its transaction. */
export async function setContactConsent(
  tenantId: string,
  clientId: string,
  contactId: string,
  consent: MessagingConsent,
  source: string | null,
  client?: PoolClient,
): Promise<void> {
  const run = client ? (t: string, p: unknown[]) => client.query(t, p) : (t: string, p: unknown[]) => query(t, p);
  await run(
    `UPDATE contacts SET messaging_consent=$4, consent_updated_at=now(), consent_source=$5, updated_at=now()
      WHERE id=$1 AND tenant_id=$2 AND client_id=$3`,
    [contactId, tenantId, clientId, consent, source],
  );
}
