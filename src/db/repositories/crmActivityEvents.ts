import type { PoolClient } from 'pg';

/**
 * Append-only CRM activity/timeline writer. Every CRM mutation (note/task/tag/owner/
 * stage) records ONE event here, IN THE SAME TRANSACTION as the entity write, so the
 * timeline can never drift from the data. This is audit/timeline only — the notes,
 * tasks and tags remain their own entities; events never duplicate their full text.
 *
 * `detail` is a small JSON object (validated by the DB CHECK jsonb_typeof='object')
 * with only the ids/labels the timeline needs — never secrets or full conversation
 * bodies.
 */
export type CrmEventType =
  | 'note_created'
  | 'note_updated'
  | 'note_deleted'
  | 'task_created'
  | 'task_completed'
  | 'task_reopened'
  | 'task_cancelled'
  | 'task_assigned'
  | 'tag_added'
  | 'tag_removed'
  | 'owner_changed'
  | 'stage_changed';

export interface RecordCrmActivityInput {
  tenantId: string;
  clientId: string;
  contactId: string;
  eventType: CrmEventType;
  actorUserId: string | null;
  detail?: Record<string, unknown>;
}

/** Insert one activity event on the transaction client. Caller owns the tx. */
export async function recordCrmActivity(
  client: PoolClient,
  input: RecordCrmActivityInput,
): Promise<void> {
  await client.query(
    `INSERT INTO crm_activity_events (tenant_id, client_id, contact_id, event_type, actor_user_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.tenantId,
      input.clientId,
      input.contactId,
      input.eventType,
      input.actorUserId,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}
