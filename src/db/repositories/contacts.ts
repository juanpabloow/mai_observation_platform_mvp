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
  channel: string;
  channelUserId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

/**
 * Race-safe resolve-or-create by canonical identity (tenant, channel,
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
    `INSERT INTO contacts (tenant_id, channel, channel_user_id, name, phone_e164, email, last_contact_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (tenant_id, channel, channel_user_id) DO UPDATE
       SET name = COALESCE(contacts.name, EXCLUDED.name),
           phone_e164 = COALESCE(contacts.phone_e164, EXCLUDED.phone_e164),
           email = COALESCE(contacts.email, EXCLUDED.email),
           last_contact_at = now(),
           updated_at = now()
     RETURNING *`,
    [input.tenantId, input.channel, input.channelUserId, input.name ?? null, phone, input.email ?? null],
  );
  return firstRowOrThrow(r, 'resolveOrCreateContact');
}

export async function getContactById(tenantId: string, id: string): Promise<ContactRow | null> {
  const r = await query<ContactRow>(`SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return r.rows[0] ?? null;
}

export interface ContactListItem extends ContactRow {
  is_customer: boolean;
  completed_count: number;
  next_appointment_at: Date | null;
  last_conversation_at: Date | null;
  visit_count: number;
}

/** Contact list with derived customer status, next upcoming appointment, visits
 * (completed appts), and last conversation activity. Tenant-scoped. */
export async function listContacts(
  tenantId: string,
  opts: { search?: string; stage?: ContactStage; limit?: number } = {},
): Promise<ContactListItem[]> {
  const params: unknown[] = [tenantId];
  const where: string[] = ['c.tenant_id = $1'];
  if (opts.stage) {
    params.push(opts.stage);
    where.push(`c.stage = $${params.length}`);
  }
  if (opts.search) {
    params.push(`%${opts.search}%`);
    where.push(`(c.name ILIKE $${params.length} OR c.phone_e164 ILIKE $${params.length} OR c.email ILIKE $${params.length} OR c.channel_user_id ILIKE $${params.length})`);
  }
  params.push(Math.min(opts.limit ?? 200, 500));
  const r = await query<ContactListItem>(
    `SELECT c.*,
            COALESCE(a.completed_count, 0) AS completed_count,
            (COALESCE(a.completed_count, 0) > 0) AS is_customer,
            COALESCE(a.completed_count, 0) AS visit_count,
            a.next_appointment_at,
            conv.last_conversation_at
       FROM contacts c
       LEFT JOIN (
         SELECT contact_id,
                COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
                MIN(start_at) FILTER (WHERE status IN ('scheduled','confirmed') AND start_at >= now()) AS next_appointment_at
           FROM appointments
          WHERE tenant_id = $1 AND contact_id IS NOT NULL
          GROUP BY contact_id
       ) a ON a.contact_id = c.id
       LEFT JOIN (
         SELECT contact_id, MAX(COALESCE(last_message_at, updated_at)) AS last_conversation_at
           FROM conversations
          WHERE tenant_id = $1 AND contact_id IS NOT NULL
          GROUP BY contact_id
       ) conv ON conv.contact_id = c.id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_contact_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

/** Conversations belonging to a contact (for the contact detail view). */
export async function listContactConversations(
  tenantId: string,
  contactId: string,
): Promise<Array<{ id: string; n8n_workflow_id: string; conversation_ref: string; mode: string; last_message_at: Date | null }>> {
  const r = await query(
    `SELECT id, n8n_workflow_id, conversation_ref, mode, last_message_at
       FROM conversations
      WHERE tenant_id = $1 AND contact_id = $2
      ORDER BY COALESCE(last_message_at, updated_at) DESC`,
    [tenantId, contactId],
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
  if (sets.length === 0) return getContactById(tenantId, id);
  sets.push('updated_at = now()');
  const r = await query<ContactRow>(
    `UPDATE contacts SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return r.rows[0] ?? null;
}
