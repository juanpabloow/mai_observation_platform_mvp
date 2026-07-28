import { query, withTransaction } from '../client.js';
import { recordCrmActivity } from './crmActivityEvents.js';

/**
 * contact_notes repository. Notes are soft-deleted (deleted_at). Every write runs in
 * ONE transaction that also records the matching crm_activity_event. All reads +
 * writes are scoped by tenant_id + client_id, and every write first verifies the
 * contact belongs to that (tenant, client) — a foreign/bogus contactId returns null
 * (generic not-found), never a DB error and never a cross-client write.
 */

export interface ContactNoteRow {
  id: string;
  tenant_id: string;
  client_id: string;
  contact_id: string;
  body: string;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ContactNoteView extends ContactNoteRow {
  author_name: string | null;
}

/** Contact must belong to (tenant, client). Returns true inside the given tx. */
async function contactInClient(
  client: import('pg').PoolClient,
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM contacts WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [contactId, tenantId, clientId],
  );
  return r.rows.length > 0;
}

export async function createNote(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  body: string;
  createdByUserId: string;
}): Promise<ContactNoteRow | null> {
  return withTransaction(async (client) => {
    if (!(await contactInClient(client, input.tenantId, input.clientId, input.contactId))) return null;
    const r = await client.query<ContactNoteRow>(
      `INSERT INTO contact_notes (tenant_id, client_id, contact_id, body, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.tenantId, input.clientId, input.contactId, input.body, input.createdByUserId],
    );
    const note = r.rows[0];
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: input.contactId,
      eventType: 'note_created',
      actorUserId: input.createdByUserId,
      detail: { note_id: note.id },
    });
    return note;
  });
}

/** One note (active or deleted) for a permission check. */
export async function getNoteById(
  tenantId: string,
  clientId: string,
  noteId: string,
): Promise<ContactNoteRow | null> {
  const r = await query<ContactNoteRow>(
    `SELECT * FROM contact_notes WHERE id = $1 AND tenant_id = $2 AND client_id = $3`,
    [noteId, tenantId, clientId],
  );
  return r.rows[0] ?? null;
}

export async function updateNote(input: {
  tenantId: string;
  clientId: string;
  noteId: string;
  body: string;
  actorUserId: string;
}): Promise<ContactNoteRow | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<ContactNoteRow>(
      `UPDATE contact_notes SET body = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [input.noteId, input.tenantId, input.clientId, input.body],
    );
    const note = cur.rows[0];
    if (!note) return null;
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: note.contact_id,
      eventType: 'note_updated',
      actorUserId: input.actorUserId,
      detail: { note_id: note.id },
    });
    return note;
  });
}

/** Soft delete (deleted_at). Records note_deleted. Returns the row or null. */
export async function softDeleteNote(input: {
  tenantId: string;
  clientId: string;
  noteId: string;
  actorUserId: string;
}): Promise<ContactNoteRow | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<ContactNoteRow>(
      `UPDATE contact_notes SET deleted_at = now(), updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [input.noteId, input.tenantId, input.clientId],
    );
    const note = cur.rows[0];
    if (!note) return null;
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: note.contact_id,
      eventType: 'note_deleted',
      actorUserId: input.actorUserId,
      detail: { note_id: note.id },
    });
    return note;
  });
}

/** Active notes for a contact, newest first, with the author's display name. */
export async function listNotesForContact(
  tenantId: string,
  clientId: string,
  contactId: string,
): Promise<ContactNoteView[]> {
  const r = await query<ContactNoteView>(
    `SELECT n.*, u.name AS author_name
       FROM contact_notes n
       LEFT JOIN "user" u ON u.id = n.created_by_user_id
      WHERE n.tenant_id = $1 AND n.client_id = $2 AND n.contact_id = $3 AND n.deleted_at IS NULL
      ORDER BY n.created_at DESC`,
    [tenantId, clientId, contactId],
  );
  return r.rows;
}
