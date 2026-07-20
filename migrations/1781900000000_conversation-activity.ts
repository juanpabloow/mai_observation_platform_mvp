import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * H-7: conversations.last_user_message_at — the timestamp of the most recent CUSTOMER
 * ('user') message, used to compute the ACTIVE/INACTIVE dimension (active iff within
 * ACTIVITY_WINDOW_HOURS). Never a stored flag — the boolean is computed in SQL at read
 * time, so no cron and no drift.
 *
 * Backfilled from handoff_messages (max occurred_at per conversation where sender=user).
 * Kept fresh by insertMessage (GREATEST, out-of-order-safe, same pattern as
 * last_message_at). Index supports per-workflow activity sort/filter.
 *
 * Fully reversible.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN last_user_message_at timestamptz;

    UPDATE conversations c
       SET last_user_message_at = sub.max_at
      FROM (
        SELECT conversation_id, max(occurred_at) AS max_at
          FROM handoff_messages
         WHERE sender = 'user'
         GROUP BY conversation_id
      ) sub
     WHERE sub.conversation_id = c.id;

    CREATE INDEX conversations_workflow_activity_idx
      ON conversations (tenant_id, n8n_workflow_id, last_user_message_at);
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX IF EXISTS conversations_workflow_activity_idx;
    ALTER TABLE conversations DROP COLUMN IF EXISTS last_user_message_at;
  `);
}
