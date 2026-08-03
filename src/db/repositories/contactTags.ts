import type { PoolClient } from 'pg';
import { isUniqueViolation, query, withTransaction } from '../client.js';
import { recordCrmActivity } from './crmActivityEvents.js';

/**
 * contact_tags (per-client catalogue) + contact_tag_links (contact ↔ tag). Tag names
 * are unique case-insensitively PER CLIENT (two clients may reuse a name). Catalog
 * CRUD (create/rename/delete) is owner/admin; attaching/detaching a tag to a contact
 * records a tag_added / tag_removed activity event in the same transaction and is
 * idempotent. All reads/writes are tenant + client scoped.
 */

export type TagColor =
  | 'gray' | 'red' | 'orange' | 'amber' | 'green' | 'teal' | 'blue' | 'indigo' | 'purple' | 'pink';

export interface ContactTagRow {
  id: string;
  tenant_id: string;
  client_id: string;
  name: string;
  color: TagColor;
  created_at: Date;
  updated_at: Date;
}

export type TagResult = { ok: true; tag: ContactTagRow } | { ok: false; reason: 'duplicate' };

export async function createTag(input: {
  tenantId: string;
  clientId: string;
  name: string;
  color: TagColor;
}): Promise<TagResult> {
  try {
    const r = await query<ContactTagRow>(
      `INSERT INTO contact_tags (tenant_id, client_id, name, color) VALUES ($1, $2, $3, $4) RETURNING *`,
      [input.tenantId, input.clientId, input.name, input.color],
    );
    return { ok: true, tag: r.rows[0] };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

export async function getTagById(tenantId: string, clientId: string, tagId: string): Promise<ContactTagRow | null> {
  const r = await query<ContactTagRow>(
    `SELECT * FROM contact_tags WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [tagId, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

export async function renameTag(input: {
  tenantId: string;
  clientId: string;
  tagId: string;
  name?: string;
  color?: TagColor;
}): Promise<TagResult | null> {
  const sets: string[] = [];
  const params: unknown[] = [input.tagId, input.tenantId, input.clientId];
  const add = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  if (input.name !== undefined) add('name', input.name);
  if (input.color !== undefined) add('color', input.color);
  if (sets.length === 0) {
    const cur = await getTagById(input.tenantId, input.clientId, input.tagId);
    return cur ? { ok: true, tag: cur } : null;
  }
  sets.push('updated_at = now()');
  try {
    const r = await query<ContactTagRow>(
      `UPDATE contact_tags SET ${sets.join(', ')} WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
      params,
    );
    if (!r.rows[0]) return null;
    return { ok: true, tag: r.rows[0] };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate' };
    throw err;
  }
}

/** Delete a tag (its links cascade via FK). Returns true if a row was removed. */
export async function deleteTag(tenantId: string, clientId: string, tagId: string): Promise<boolean> {
  const r = await query(`DELETE FROM contact_tags WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [
    tagId,
    tenantId,
    clientId,
  ]);
  return (r.rowCount ?? 0) > 0;
}

/** The client's tag catalogue with usage counts. */
export interface ContactTagWithCount extends ContactTagRow {
  usage_count: number;
}
export async function listTags(tenantId: string, clientId: string): Promise<ContactTagWithCount[]> {
  const r = await query<ContactTagWithCount>(
    `SELECT t.*, count(l.id)::int AS usage_count
       FROM contact_tags t
       LEFT JOIN contact_tag_links l ON l.tag_id = t.id AND l.tenant_id = t.tenant_id AND l.client_id = t.client_id
      WHERE t.tenant_id = $1 AND t.client_id = $2
      GROUP BY t.id
      ORDER BY lower(t.name)`,
    [tenantId, clientId],
  );
  return r.rows;
}

async function belongsToClient(
  client: PoolClient,
  table: 'contacts' | 'contact_tags',
  tenantId: string,
  clientId: string,
  id: string,
): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM ${table} WHERE id = $1 AND tenant_id = $2 AND client_id = $3`, [
    id,
    tenantId,
    clientId,
  ]);
  return r.rows.length > 0;
}

/** Attach a tag to a contact (idempotent). Records tag_added ONLY when a new link is
 * created. Returns { ok:false } if the contact or tag isn't this client's. */
export async function attachTag(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  tagId: string;
  /** null for an automation actor (C-5). */
  actorUserId: string | null;
  actorKind?: 'user' | 'automation';
}): Promise<{ ok: boolean; added: boolean }> {
  return withTransaction(async (client) => {
    const okContact = await belongsToClient(client, 'contacts', input.tenantId, input.clientId, input.contactId);
    const okTag = await belongsToClient(client, 'contact_tags', input.tenantId, input.clientId, input.tagId);
    if (!okContact || !okTag) return { ok: false, added: false };
    const r = await client.query(
      `INSERT INTO contact_tag_links (tenant_id, client_id, contact_id, tag_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (contact_id, tag_id) DO NOTHING
       RETURNING id`,
      [input.tenantId, input.clientId, input.contactId, input.tagId, input.actorUserId],
    );
    const added = r.rows.length > 0;
    if (added) {
      await recordCrmActivity(client, {
        tenantId: input.tenantId,
        clientId: input.clientId,
        contactId: input.contactId,
        eventType: 'tag_added',
        actorUserId: input.actorUserId,
        actorKind: input.actorKind ?? 'user',
        detail: { tag_id: input.tagId },
      });
    }
    return { ok: true, added };
  });
}

/** Detach a tag from a contact. Records tag_removed ONLY when a link existed. */
export async function detachTag(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  tagId: string;
  /** null for an automation actor (C-5). */
  actorUserId: string | null;
  actorKind?: 'user' | 'automation';
}): Promise<{ ok: boolean; removed: boolean }> {
  return withTransaction(async (client) => {
    const r = await client.query(
      `DELETE FROM contact_tag_links
        WHERE tenant_id = $1 AND client_id = $2 AND contact_id = $3 AND tag_id = $4`,
      [input.tenantId, input.clientId, input.contactId, input.tagId],
    );
    const removed = (r.rowCount ?? 0) > 0;
    if (removed) {
      await recordCrmActivity(client, {
        tenantId: input.tenantId,
        clientId: input.clientId,
        contactId: input.contactId,
        eventType: 'tag_removed',
        actorUserId: input.actorUserId,
        actorKind: input.actorKind ?? 'user',
        detail: { tag_id: input.tagId },
      });
    }
    return { ok: true, removed };
  });
}

/** Tags attached to one contact. */
export async function listTagsForContact(
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<ContactTagRow[]> {
  const r = await query<ContactTagRow>(
    `SELECT t.*
       FROM contact_tag_links l
       JOIN contact_tags t ON t.id = l.tag_id AND t.tenant_id = l.tenant_id AND t.client_id = l.client_id
      WHERE l.tenant_id = $1 AND l.client_id = $2 AND l.contact_id = $3
      ORDER BY lower(t.name)`,
    [tenantId, clientId, contactId],
  );
  return r.rows;
}

/** Tags for many contacts — ONE batched query for the list page (no N+1). */
export async function tagsByContacts(
  tenantId: string,
  clientId: string,
  contactIds: string[],
): Promise<Map<string, ContactTagRow[]>> {
  if (contactIds.length === 0) return new Map();
  const r = await query<ContactTagRow & { contact_id: string }>(
    `SELECT l.contact_id, t.*
       FROM contact_tag_links l
       JOIN contact_tags t ON t.id = l.tag_id AND t.tenant_id = l.tenant_id AND t.client_id = l.client_id
      WHERE l.tenant_id = $1 AND l.client_id = $2 AND l.contact_id = ANY($3::uuid[])
      ORDER BY lower(t.name)`,
    [tenantId, clientId, contactIds],
  );
  const map = new Map<string, ContactTagRow[]>();
  for (const row of r.rows) {
    const { contact_id, ...tag } = row;
    const list = map.get(contact_id) ?? [];
    list.push(tag as ContactTagRow);
    map.set(contact_id, list);
  }
  return map;
}
