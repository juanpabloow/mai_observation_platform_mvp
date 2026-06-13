import { query } from '../client.js';

/**
 * A derived conversation turn: one user message (and its AI reply, if captured)
 * reconstructed from a single execution via that workflow's conversation
 * mappings. One row per execution (UNIQUE execution_id) — re-deriving upserts.
 */
export interface ConversationTurnRow {
  id: string;
  tenant_id: string;
  n8n_workflow_id: string;
  execution_id: string;
  conversation_id: string;
  contact_name: string | null;
  user_message: string | null;
  ai_response: string | null;
  turn_timestamp: Date;
  created_at: Date;
}

export interface UpsertTurnInput {
  tenantId: string;
  n8nWorkflowId: string;
  executionId: string;
  conversationId: string;
  contactName: string | null;
  userMessage: string | null;
  aiResponse: string | null;
  turnTimestamp: Date | string;
}

/**
 * Insert (or update) the turn for an execution. Idempotent on execution_id: a
 * re-derive (e.g. after a mapping change) overwrites the existing row's fields
 * rather than creating a duplicate. created_at is preserved on update.
 */
export async function upsertTurn(input: UpsertTurnInput): Promise<void> {
  await query(
    `INSERT INTO conversation_turns
       (tenant_id, n8n_workflow_id, execution_id, conversation_id,
        contact_name, user_message, ai_response, turn_timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (execution_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       n8n_workflow_id = EXCLUDED.n8n_workflow_id,
       conversation_id = EXCLUDED.conversation_id,
       contact_name = EXCLUDED.contact_name,
       user_message = EXCLUDED.user_message,
       ai_response = EXCLUDED.ai_response,
       turn_timestamp = EXCLUDED.turn_timestamp`,
    [
      input.tenantId,
      input.n8nWorkflowId,
      input.executionId,
      input.conversationId,
      input.contactName,
      input.userMessage,
      input.aiResponse,
      input.turnTimestamp,
    ],
  );
}

/**
 * Delete the turn for an execution (tenant-scoped). Used when a re-derive finds
 * the execution is no longer a turn (e.g. its mapping was removed). Returns true
 * if a row was removed.
 */
export async function deleteTurnByExecution(params: {
  tenantId: string;
  executionId: string;
}): Promise<boolean> {
  const result = await query(
    `DELETE FROM conversation_turns WHERE execution_id = $1 AND tenant_id = $2`,
    [params.executionId, params.tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Count derived turns for a workflow (tenant-scoped). */
export async function countTurns(params: {
  tenantId: string;
  n8nWorkflowId: string;
}): Promise<number> {
  const result = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM conversation_turns
      WHERE tenant_id = $1 AND n8n_workflow_id = $2`,
    [params.tenantId, params.n8nWorkflowId],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** One distinct conversation (thread) in the workflow's turn data. */
export interface ConversationSummary {
  conversation_id: string;
  /** Most recent non-null contact_name across the thread's turns. */
  contact_name: string | null;
  /** The latest turn's user message (preview for the conversation list). */
  last_user_message: string | null;
  /** The latest turn's AI response (may be null). */
  last_ai_response: string | null;
  turn_count: number;
  last_activity: Date;
}

/**
 * Distinct conversations for a workflow (tenant-scoped), newest activity first.
 * Each row aggregates a thread: turn count, last activity, a preview of the most
 * recent turn, and the most recent non-null contact name.
 */
export async function listConversations(params: {
  tenantId: string;
  n8nWorkflowId: string;
}): Promise<ConversationSummary[]> {
  const result = await query<ConversationSummary>(
    `SELECT
        conversation_id,
        (array_agg(contact_name ORDER BY turn_timestamp DESC)
           FILTER (WHERE contact_name IS NOT NULL))[1] AS contact_name,
        (array_agg(user_message ORDER BY turn_timestamp DESC))[1] AS last_user_message,
        (array_agg(ai_response ORDER BY turn_timestamp DESC))[1] AS last_ai_response,
        COUNT(*)::int AS turn_count,
        MAX(turn_timestamp) AS last_activity
       FROM conversation_turns
      WHERE tenant_id = $1 AND n8n_workflow_id = $2
      GROUP BY conversation_id
      ORDER BY last_activity DESC`,
    [params.tenantId, params.n8nWorkflowId],
  );
  return result.rows;
}

/**
 * All turns for one conversation (tenant-scoped), in chronological order — a
 * ready-to-render transcript. created_at breaks ties on equal turn_timestamp.
 */
export async function listTurnsForConversation(params: {
  tenantId: string;
  n8nWorkflowId: string;
  conversationId: string;
}): Promise<ConversationTurnRow[]> {
  const result = await query<ConversationTurnRow>(
    `SELECT id, tenant_id, n8n_workflow_id, execution_id, conversation_id,
            contact_name, user_message, ai_response, turn_timestamp, created_at
       FROM conversation_turns
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND conversation_id = $3
      ORDER BY turn_timestamp ASC, created_at ASC`,
    [params.tenantId, params.n8nWorkflowId, params.conversationId],
  );
  return result.rows;
}
