import { query, withTransaction } from '../client.js';
import { recordCrmActivity } from './crmActivityEvents.js';
import type { ContactRow, ContactStage } from './contacts.js';

/**
 * Contact CRM-field mutations that must ALSO write a timeline event in the same
 * transaction: owner (assigned_to) and lifecycle stage. Kept out of contacts.ts so
 * that file stays the canonical-identity repo. All tenant + client scoped; a
 * foreign/bogus contact returns null (generic).
 */

/** Is this user a member of the tenant (an assignable owner)? */
export async function isTenantMember(tenantId: string, userId: string): Promise<boolean> {
  const r = await query(`SELECT 1 FROM tenant_members WHERE tenant_id = $1 AND user_id = $2`, [tenantId, userId]);
  return r.rows.length > 0;
}

export async function changeContactOwner(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  ownerUserId: string | null;
  actorUserId: string;
}): Promise<ContactRow | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<ContactRow>(
      `SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`,
      [input.contactId, input.tenantId, input.clientId],
    );
    const contact = cur.rows[0];
    if (!contact) return null;
    if (contact.assigned_to === input.ownerUserId) return contact; // no-op, no event
    const upd = await client.query<ContactRow>(
      `UPDATE contacts SET assigned_to = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
      [input.contactId, input.tenantId, input.clientId, input.ownerUserId],
    );
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: input.contactId,
      eventType: 'owner_changed',
      actorUserId: input.actorUserId,
      detail: { from: contact.assigned_to, to: input.ownerUserId },
    });
    return upd.rows[0];
  });
}

export async function changeContactStage(input: {
  tenantId: string;
  clientId: string;
  contactId: string;
  stage: ContactStage;
  actorUserId: string;
}): Promise<ContactRow | null> {
  return withTransaction(async (client) => {
    const cur = await client.query<ContactRow>(
      `SELECT * FROM contacts WHERE id = $1 AND tenant_id = $2 AND client_id = $3 FOR UPDATE`,
      [input.contactId, input.tenantId, input.clientId],
    );
    const contact = cur.rows[0];
    if (!contact) return null;
    if (contact.stage === input.stage) return contact; // no-op, no event
    const upd = await client.query<ContactRow>(
      `UPDATE contacts SET stage = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 AND client_id = $3 RETURNING *`,
      [input.contactId, input.tenantId, input.clientId, input.stage],
    );
    await recordCrmActivity(client, {
      tenantId: input.tenantId,
      clientId: input.clientId,
      contactId: input.contactId,
      eventType: 'stage_changed',
      actorUserId: input.actorUserId,
      detail: { from: contact.stage, to: input.stage },
    });
    return upd.rows[0];
  });
}
