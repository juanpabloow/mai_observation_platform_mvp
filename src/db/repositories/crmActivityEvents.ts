import type { PoolClient } from 'pg';

/**
 * Append-only writer for crm_activity_events — the CRM-NATIVE fact store (C-3).
 *
 * THIS IS NOT A DUAL-WRITE TIMELINE LOG. It records ONLY facts that have no other
 * home: stage_changed, owner_changed, tag_added/removed, contact_merged,
 * consent_changed. note_ and task_ rows are AUDIT-ONLY (who/when a note/task changed) —
 * getContactTimeline reads notes and tasks from their OWN tables, and reads
 * conversations + appointments from theirs, so NOTHING here duplicates a fact that
 * lives elsewhere. Never write an appointment/message/conversation event here.
 *
 * Every CRM mutation records its event IN THE SAME TRANSACTION as the entity write,
 * so the audit can't drift. `detail` is a small JSON object (DB CHECK
 * jsonb_typeof='object') carrying only the ids/labels the timeline needs.
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
  | 'stage_changed'
  | 'contact_merged'
  | 'consent_changed';

export type ActorKind = 'user' | 'automation';

export interface RecordCrmActivityInput {
  tenantId: string;
  clientId: string;
  contactId: string;
  eventType: CrmEventType;
  actorUserId: string | null;
  /** Who drove the change (C-5). 'automation' → the timeline attributes it to the
   *  machine rather than "System"; defaults 'user' for the existing session paths. */
  actorKind?: ActorKind;
  detail?: Record<string, unknown>;
}

/** Insert one activity event on the transaction client. Caller owns the tx. */
export async function recordCrmActivity(client: PoolClient, input: RecordCrmActivityInput): Promise<void> {
  await client.query(
    `INSERT INTO crm_activity_events (tenant_id, client_id, contact_id, event_type, actor_user_id, actor_kind, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [input.tenantId, input.clientId, input.contactId, input.eventType, input.actorUserId, input.actorKind ?? 'user', JSON.stringify(input.detail ?? {})],
  );
}
