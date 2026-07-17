import { pool, query, firstRowOrThrow } from '../client.js';

/**
 * H-1a repository for the stateful handoff entities: conversations, their message
 * events, and the mode-transition audit trail. (Handoff tokens live in
 * handoffTokens.ts.) Plain SQL, shared by worker + web, EVERY function tenant-
 * scoped. transitionMode() is the single chokepoint for mode changes.
 */

export type ConversationMode = 'bot' | 'pending' | 'human';
export type MessageSender = 'user' | 'bot' | 'human_agent';
export type MessageStatus = 'received' | 'sending' | 'sent' | 'failed';
export type TransitionSource = 'workflow' | 'platform_rule' | 'agent';

export interface ConversationRow {
  id: string;
  tenant_id: string;
  n8n_workflow_id: string;
  conversation_ref: string;
  mode: ConversationMode;
  assigned_agent_user_id: string | null;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface HandoffMessageRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  sender: MessageSender;
  agent_user_id: string | null;
  text: string | null;
  content_type: string;
  content_detail: string | null;
  external_message_id: string | null;
  status: MessageStatus;
  failure_code: string | null;
  failure_detail: string | null;
  occurred_at: Date;
  created_at: Date;
  metadata: unknown | null;
}

export interface ModeTransitionRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  from_mode: ConversationMode;
  to_mode: ConversationMode;
  source: TransitionSource;
  agent_user_id: string | null;
  reason_code: string | null;
  detail: string | null;
  created_at: Date;
}

/** A mode change was requested on a conversation that isn't this tenant's. */
export class ConversationNotFoundError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation ${conversationId} not found for tenant`);
    this.name = 'ConversationNotFoundError';
  }
}

/** A requested mode change is not a legal edge (or not allowed for that source). */
export class IllegalModeTransitionError extends Error {
  constructor(
    public readonly from: ConversationMode,
    public readonly to: ConversationMode,
    public readonly source: TransitionSource,
    detail?: string,
  ) {
    super(`Illegal mode transition ${from} → ${to} (source=${source})${detail ? `: ${detail}` : ''}`);
    this.name = 'IllegalModeTransitionError';
  }
}

/**
 * The mode state machine — the ONLY legal edges, with the sources allowed on each.
 *   bot → pending  (workflow | platform_rule)   -- an escalation is raised
 *   bot → human    (agent)                       -- an agent takes over directly
 *   pending → human(agent)                       -- an agent claims an escalation
 *   pending → bot  (agent)                       -- an agent dismisses it
 *   human → bot    (agent)                       -- an agent hands back to the bot
 */
const LEGAL_TRANSITIONS: ReadonlyArray<{
  from: ConversationMode;
  to: ConversationMode;
  sources: ReadonlyArray<TransitionSource>;
}> = [
  { from: 'bot', to: 'pending', sources: ['workflow', 'platform_rule'] },
  { from: 'bot', to: 'human', sources: ['agent'] },
  { from: 'pending', to: 'human', sources: ['agent'] },
  { from: 'pending', to: 'bot', sources: ['agent'] },
  { from: 'human', to: 'bot', sources: ['agent'] },
];

/**
 * Race-safe get-or-create of a conversation by its unique triple. Concurrent
 * callers with the same triple all end up with the ONE row: the winner inserts,
 * the losers hit ON CONFLICT DO NOTHING (no row returned) and re-select it.
 */
export async function getOrCreateConversation(
  tenantId: string,
  n8nWorkflowId: string,
  conversationRef: string,
): Promise<ConversationRow> {
  const inserted = await query<ConversationRow>(
    `INSERT INTO conversations (tenant_id, n8n_workflow_id, conversation_ref)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, n8n_workflow_id, conversation_ref) DO NOTHING
     RETURNING *`,
    [tenantId, n8nWorkflowId, conversationRef],
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await query<ConversationRow>(
    `SELECT * FROM conversations
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND conversation_ref = $3`,
    [tenantId, n8nWorkflowId, conversationRef],
  );
  return firstRowOrThrow(existing, 'getOrCreateConversation re-select');
}

/**
 * The conversation's current mode, or 'bot' when it doesn't exist — per the
 * contract, an unknown conversation was never escalated, so it's bot-driven.
 */
export async function getMode(
  tenantId: string,
  n8nWorkflowId: string,
  conversationRef: string,
): Promise<ConversationMode> {
  const r = await query<{ mode: ConversationMode }>(
    `SELECT mode FROM conversations
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND conversation_ref = $3`,
    [tenantId, n8nWorkflowId, conversationRef],
  );
  return r.rows[0]?.mode ?? 'bot';
}

export interface InsertMessageInput {
  tenantId: string;
  conversationId: string;
  sender: MessageSender;
  /** Required iff sender = 'human_agent'; must be absent otherwise. */
  agentUserId?: string | null;
  text?: string | null;
  contentType?: string;
  contentDetail?: string | null;
  externalMessageId?: string | null;
  status: MessageStatus;
  failureCode?: string | null;
  failureDetail?: string | null;
  occurredAt: Date;
  metadata?: unknown;
}

/**
 * Insert a message event. DEDUP: when external_message_id is present and already
 * exists for this conversation, no duplicate is written — the EXISTING row is
 * returned with { deduped: true } (no error). NULL external ids never dedup (the
 * partial unique index exempts them), so un-keyed messages always insert. A newly
 * inserted message advances conversations.last_message_at.
 */
export async function insertMessage(
  input: InsertMessageInput,
): Promise<{ message: HandoffMessageRow; deduped: boolean }> {
  // Repo-enforced invariant (mirrors the conversations mode↔agent rule): the agent
  // id is set iff the sender is a human agent. Not a DB CHECK — see the migration.
  const isAgent = input.sender === 'human_agent';
  if (isAgent && !input.agentUserId) {
    throw new Error("insertMessage: a 'human_agent' message requires agentUserId");
  }
  if (!isAgent && input.agentUserId) {
    throw new Error("insertMessage: agentUserId is only allowed for a 'human_agent' sender");
  }

  const inserted = await query<HandoffMessageRow>(
    `INSERT INTO handoff_messages
       (tenant_id, conversation_id, sender, agent_user_id, text, content_type, content_detail,
        external_message_id, status, failure_code, failure_detail, occurred_at, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL
       DO NOTHING
     RETURNING *`,
    [
      input.tenantId,
      input.conversationId,
      input.sender,
      input.agentUserId ?? null,
      input.text ?? null,
      input.contentType ?? 'text',
      input.contentDetail ?? null,
      input.externalMessageId ?? null,
      input.status,
      input.failureCode ?? null,
      input.failureDetail ?? null,
      input.occurredAt,
      input.metadata ?? null,
    ],
  );

  if (inserted.rows[0]) {
    // GREATEST ignores NULLs, so the first message sets last_message_at and later
    // (possibly out-of-order) ones only advance it.
    await query(
      `UPDATE conversations
          SET last_message_at = GREATEST(last_message_at, $3), updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [input.conversationId, input.tenantId, input.occurredAt],
    );
    return { message: inserted.rows[0], deduped: false };
  }

  // Conflict → the external id already exists in this conversation; return it.
  const existing = await query<HandoffMessageRow>(
    `SELECT * FROM handoff_messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND external_message_id = $3`,
    [input.tenantId, input.conversationId, input.externalMessageId],
  );
  return { message: firstRowOrThrow(existing, 'insertMessage dedup re-select'), deduped: true };
}

/**
 * A page of a conversation's messages, newest first. `before` (an occurred_at
 * cursor) fetches the messages older than it; id is the stable tiebreaker.
 */
export async function listMessages(
  tenantId: string,
  conversationId: string,
  opts: { limit?: number; before?: Date } = {},
): Promise<HandoffMessageRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [tenantId, conversationId];
  let where = 'tenant_id = $1 AND conversation_id = $2';
  if (opts.before) {
    params.push(opts.before);
    where += ` AND occurred_at < $${params.length}`;
  }
  params.push(limit);
  const r = await query<HandoffMessageRow>(
    `SELECT * FROM handoff_messages
      WHERE ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows;
}

export interface TransitionOptions {
  source: TransitionSource;
  /** Required iff source = 'agent'; must be absent otherwise. */
  agentUserId?: string | null;
  reasonCode?: string | null;
  detail?: string | null;
}

export interface TransitionResult {
  changed: boolean;
  conversation: ConversationRow;
}

/**
 * THE single chokepoint for conversation mode changes. All mode changes anywhere
 * in the codebase MUST go through here.
 *
 * - Locks the conversation row (SELECT … FOR UPDATE) inside a transaction, so two
 *   agents clicking "take" at once are serialized — the second re-reads the
 *   winner's committed state.
 * - IDEMPOTENT: requesting the current mode returns { changed: false } with no
 *   audit row and no error.
 * - Validates against the state machine (legal edge + a source allowed on it, and
 *   agentUserId set iff source='agent'); anything illegal throws
 *   IllegalModeTransitionError. A foreign/unknown conversation throws
 *   ConversationNotFoundError.
 * - On a real change: updates mode + assigned_agent_user_id (set on →human,
 *   cleared on →bot) and writes exactly one audit row, atomically.
 */
export async function transitionMode(
  tenantId: string,
  conversationId: string,
  toMode: ConversationMode,
  opts: TransitionOptions,
): Promise<TransitionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<ConversationRow>(
      `SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [conversationId, tenantId],
    );
    const conversation = cur.rows[0];
    if (!conversation) {
      throw new ConversationNotFoundError(conversationId);
    }

    const from = conversation.mode;
    // Idempotent no-op — release the lock, report no change, write no audit row.
    if (from === toMode) {
      await client.query('ROLLBACK');
      return { changed: false, conversation };
    }

    const rule = LEGAL_TRANSITIONS.find((r) => r.from === from && r.to === toMode);
    if (!rule) {
      throw new IllegalModeTransitionError(from, toMode, opts.source);
    }
    if (!rule.sources.includes(opts.source)) {
      throw new IllegalModeTransitionError(
        from,
        toMode,
        opts.source,
        `source '${opts.source}' is not allowed for this transition`,
      );
    }

    const agentUserId = opts.agentUserId ?? null;
    if (opts.source === 'agent' && !agentUserId) {
      throw new IllegalModeTransitionError(from, toMode, opts.source, 'agent source requires agentUserId');
    }
    if (opts.source !== 'agent' && agentUserId) {
      throw new IllegalModeTransitionError(from, toMode, opts.source, 'agentUserId is only allowed for the agent source');
    }

    // Assignment: an agent owns a 'human' conversation; cleared on any →bot.
    const assigned = toMode === 'human' ? agentUserId : null;
    const updated = await client.query<ConversationRow>(
      `UPDATE conversations
          SET mode = $3, assigned_agent_user_id = $4, updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [conversationId, tenantId, toMode, assigned],
    );
    await client.query(
      `INSERT INTO conversation_mode_transitions
         (tenant_id, conversation_id, from_mode, to_mode, source, agent_user_id, reason_code, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, conversationId, from, toMode, opts.source, agentUserId, opts.reasonCode ?? null, opts.detail ?? null],
    );
    await client.query('COMMIT');
    return { changed: true, conversation: firstRowOrThrow(updated, 'transitionMode update') };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
