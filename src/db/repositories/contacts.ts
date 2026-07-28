import type { PoolClient, QueryResultRow } from 'pg';
import { query, firstRowOrThrow } from '../client.js';
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

export interface ContactRow {
  id: string;
  tenant_id: string;
  client_id: string;
  channel: string;
  channel_user_id: string;
  phone_e164: string | null;
  name: string | null;
  email: string | null;
  bot_human_mode: BotHumanMode;
  stage: ContactStage;
  assigned_to: string | null;
  first_contact_at: Date;
  last_contact_at: Date;
  message_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface ResolveContactInput {
  tenantId: string;
  clientId: string;
  channel: string;
  channelUserId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

/**
 * Race-safe resolve-or-create by canonical identity (tenant, client, channel,
 * channel_user_id). On an existing row, fills in any newly-supplied name/phone/
 * email that was previously null (never overwrites known values) and advances
 * last_contact_at. Phone is normalized to E.164; an un-normalizable phone is
 * dropped rather than stored malformed. Runs on the passed client when inside a
 * booking transaction, else on the pool.
 */
export async function resolveOrCreateContact(
  input: ResolveContactInput,
  client?: PoolClient,
): Promise<ContactRow> {
  const run = <T extends QueryResultRow>(text: string, params: unknown[]) =>
    client ? client.query<T>(text, params) : query<T>(text, params);
  const phone = normalizeE164(input.phone);
  const r = await run<ContactRow>(
    `INSERT INTO contacts (tenant_id, client_id, channel, channel_user_id, name, phone_e164, email, last_contact_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (tenant_id, client_id, channel, channel_user_id) DO UPDATE
       SET name = COALESCE(contacts.name, EXCLUDED.name),
           phone_e164 = COALESCE(contacts.phone_e164, EXCLUDED.phone_e164),
           email = COALESCE(contacts.email, EXCLUDED.email),
           last_contact_at = now(),
           updated_at = now()
     RETURNING *`,
    [input.tenantId, input.clientId, input.channel, input.channelUserId, input.name ?? null, phone, input.email ?? null],
  );
  return firstRowOrThrow(r, 'resolveOrCreateContact');
}

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
  assignee_name: string | null;
}

/** CRM list filters. All are OPTIONAL and ADDITIVE — omitting them preserves the
 * original tenant-wide behaviour. `tagId`/`assignedTo`/`taskFilter` narrow to this
 * client's CRM data; `offset` drives keyset-free page navigation on the list UI. */
export interface ListContactsOpts {
  search?: string;
  stage?: ContactStage;
  clientId?: string | null;
  tagId?: string;
  assignedTo?: string;
  taskFilter?: 'open' | 'overdue';
  limit?: number;
  offset?: number;
}

/** Contact list with derived customer status, next upcoming appointment, visits
 * (completed appts), last conversation activity, and the owner's display name.
 * Tenant-scoped; the optional filters/pagination narrow it for the CRM list UI. */
export async function listContacts(
  tenantId: string,
  opts: ListContactsOpts = {},
): Promise<ContactListItem[]> {
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
  if (opts.assignedTo) {
    params.push(opts.assignedTo);
    where.push(`c.assigned_to = $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.phone_e164 ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.channel_user_id ILIKE $${params.length})`);
  }
  // Tag/task filters stay INSIDE the contact's own (tenant, client) — an EXISTS
  // over the client-scoped CRM tables never leaks a cross-client link.
  if (opts.tagId) {
    params.push(opts.tagId);
    where.push(
      `EXISTS (SELECT 1 FROM contact_tag_links l
                WHERE l.contact_id = c.id AND l.tenant_id = c.tenant_id
                  AND l.client_id = c.client_id AND l.tag_id = $${params.length})`,
    );
  }
  if (opts.taskFilter) {
    const overdueOnly = opts.taskFilter === 'overdue' ? ' AND t.due_at IS NOT NULL AND t.due_at < now()' : '';
    where.push(
      `EXISTS (SELECT 1 FROM crm_tasks t
                WHERE t.contact_id = c.id AND t.tenant_id = c.tenant_id
                  AND t.client_id = c.client_id AND t.status = 'open'${overdueOnly})`,
    );
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  // READ-SIDE CLIENT DEFENSE on the aggregates: appointment counts join on
  // contact_id AND client_id (a mislinked cross-client appointment never counts),
  // and last_conversation_at only considers conversations whose CANONICAL
  // workflow (most recently synced row for tenant + n8n_workflow_id) belongs to
  // the contact's own client.
  const limitPos = params.length;
  let tail = `LIMIT $${limitPos}`;
  if (opts.offset && opts.offset > 0) {
    params.push(opts.offset);
    tail += ` OFFSET $${params.length}`;
  }
  const r = await query<ContactListItem>(
    `SELECT c.*,
            COALESCE(a.completed_count, 0) AS completed_count,
            (COALESCE(a.completed_count, 0) > 0) AS is_customer,
            COALESCE(a.completed_count, 0) AS visit_count,
            a.next_appointment_at,
            conv.last_conversation_at,
            ownr.name AS assignee_name
       FROM contacts c
       LEFT JOIN "user" ownr ON ownr.id = c.assigned_to
       LEFT JOIN (
         SELECT contact_id, client_id,
                (COUNT(*) FILTER (WHERE status = 'completed'))::int AS completed_count,
                MIN(start_at) FILTER (WHERE status IN ('scheduled','confirmed') AND start_at >= now()) AS next_appointment_at
           FROM appointments
          WHERE tenant_id = $1 AND contact_id IS NOT NULL
          GROUP BY contact_id, client_id
       ) a ON a.contact_id = c.id AND a.client_id = c.client_id
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
      ORDER BY c.last_contact_at DESC
      ${tail}`,
    params,
  );
  return r.rows;
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
