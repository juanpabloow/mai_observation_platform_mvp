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
  /** Most recent CUSTOMER ('user') message time — drives the ACTIVE/INACTIVE dimension. */
  last_user_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The activity window (H-7): a conversation is ACTIVE iff its last CUSTOMER message is
 * within this many hours of now, else INACTIVE (null ⇒ INACTIVE). THE single source of
 * truth for the threshold — referenced by every activity computation. (Scaling-todo:
 * per-workflow configurable, since channel service windows differ.)
 */
export const ACTIVITY_WINDOW_HOURS = 24;

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
 *   human → pending(platform_rule)               -- ORPHAN RELEASE: the assigned
 *       agent was removed, so the platform re-queues the conversation. This edge is
 *       platform_rule ONLY — an agent can never move a live conversation straight
 *       from human back to pending (that would silently un-take it); an agent hands
 *       back via human → bot instead.
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
  { from: 'human', to: 'pending', sources: ['platform_rule'] },
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

/**
 * Minimal display summary of an assigned agent (Better Auth user) — for the
 * handoff API's conversation projection. Looked up by id; null if the user no
 * longer exists (an assigned agent whose account was deleted → SET NULL upstream).
 */
export async function getAgentSummary(
  userId: string,
): Promise<{ id: string; name: string | null } | null> {
  const r = await query<{ id: string; name: string | null }>(
    `SELECT id, name FROM "user" WHERE id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
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
    // (possibly out-of-order) ones only advance it. last_user_message_at advances the
    // same way but ONLY for a customer ('user') message — bot/human_agent must not
    // touch it (it's the activity signal: "the customer wrote").
    const bumpUser = input.sender === 'user';
    await query(
      `UPDATE conversations
          SET last_message_at = GREATEST(last_message_at, $3),
              last_user_message_at = CASE WHEN $4 THEN GREATEST(last_user_message_at, $3)
                                          ELSE last_user_message_at END,
              updated_at = now()
        WHERE id = $1 AND tenant_id = $2`,
      [input.conversationId, input.tenantId, input.occurredAt, bumpUser],
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
 * H-3 outbound delivery status update. Flips a message between 'sending' → 'sent' /
 * 'failed' after a webhook attempt. On 'sent' the external id is stored (COALESCE
 * keeps a prior value if the new one is null); failure_code/detail are set on
 * failure and cleared on success. Tenant-scoped. Returns the updated row or null.
 */
export async function updateMessageDelivery(params: {
  tenantId: string;
  messageId: string;
  status: MessageStatus;
  externalMessageId?: string | null;
  failureCode?: string | null;
  failureDetail?: string | null;
}): Promise<HandoffMessageRow | null> {
  const r = await query<HandoffMessageRow>(
    `UPDATE handoff_messages
        SET status = $3,
            external_message_id = COALESCE($4, external_message_id),
            failure_code = $5,
            failure_detail = $6
      WHERE tenant_id = $1 AND id = $2
      RETURNING *`,
    [
      params.tenantId,
      params.messageId,
      params.status,
      params.externalMessageId ?? null,
      params.failureCode ?? null,
      params.failureDetail ?? null,
    ],
  );
  return r.rows[0] ?? null;
}

/** A single message within a conversation (tenant-scoped) — for retrying a send. */
export async function getHandoffMessage(
  tenantId: string,
  conversationId: string,
  messageId: string,
): Promise<HandoffMessageRow | null> {
  const r = await query<HandoffMessageRow>(
    `SELECT * FROM handoff_messages
      WHERE tenant_id = $1 AND conversation_id = $2 AND id = $3`,
    [tenantId, conversationId, messageId],
  );
  return r.rows[0] ?? null;
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
  /**
   * Optional optimistic-concurrency precondition: only transition if the row is
   * STILL in this mode under the lock. If it isn't, this is a no-op ({changed:false})
   * — NOT an error. Lets an action assert "dismiss ONLY if still pending" so a
   * concurrent take can't be silently clobbered by an otherwise-legal edge.
   */
  expectedFrom?: ConversationMode;
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
    // Precondition (optimistic concurrency): a caller can require the row still be in
    // a specific mode. If it moved on, this is a no-op (not an error) — no audit row.
    if (opts.expectedFrom && from !== opts.expectedFrom) {
      await client.query('ROLLBACK');
      return { changed: false, conversation };
    }
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

/**
 * ORPHAN RELEASE. When an agent loses access to conversations they were assigned to
 * — they were removed from a client, or from the tenant — a customer must never be
 * left stranded in a silent 'human' conversation nobody is watching. This finds the
 * agent's live 'human' conversations and re-queues each (human → pending, source
 * 'platform_rule', reason_code 'agent_removed') so it re-enters the inbox. Clearing
 * the assignment is handled by transitionMode (agent set iff mode='human').
 *
 * Scope (at most one of clientId / exceptClientId):
 *   - neither        → tenant-wide (the agent left the tenant entirely).
 *   - clientId       → only conversations of THAT client's workflows (the agent was
 *                      removed from one client; their conversations elsewhere untouched).
 *   - exceptClientId → conversations of every client EXCEPT that one (an admin demoted
 *                      to a member of one client loses access to all the others).
 *
 * A conversation belongs to a client iff its workflow's CANONICAL row (most recently
 * synced, mirroring getWorkflowByN8nId) is assigned to that client. Best-effort per
 * conversation: a concurrent change on one row is swallowed so the sweep still
 * releases the rest. Returns how many were actually re-queued.
 */
export async function releaseAgentConversations(
  tenantId: string,
  agentUserId: string,
  opts: { clientId?: string; exceptClientId?: string } = {},
): Promise<number> {
  const params: unknown[] = [tenantId, agentUserId];
  let clientFilter = '';
  // Resolve the conversation's canonical client the same way getWorkflowByN8nId does.
  const CANONICAL = `
    SELECT 1 FROM (
      SELECT DISTINCT ON (n8n_workflow_id) client_id
        FROM workflows w
       WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
       ORDER BY n8n_workflow_id, last_synced_at DESC NULLS LAST
    ) canonical
    WHERE canonical.client_id = $3`;
  if (opts.clientId) {
    params.push(opts.clientId);
    clientFilter = `AND EXISTS (${CANONICAL})`;
  } else if (opts.exceptClientId) {
    params.push(opts.exceptClientId);
    // Release everywhere the canonical client is NOT the kept one (incl. no client).
    clientFilter = `AND NOT EXISTS (${CANONICAL})`;
  }

  const targets = await query<{ id: string }>(
    `SELECT c.id FROM conversations c
      WHERE c.tenant_id = $1 AND c.mode = 'human' AND c.assigned_agent_user_id = $2
      ${clientFilter}`,
    params,
  );

  let released = 0;
  for (const row of targets.rows) {
    try {
      const res = await transitionMode(tenantId, row.id, 'pending', {
        source: 'platform_rule',
        reasonCode: 'agent_removed',
        // The acting agent_user_id column is for the platform actor (null here); the
        // released agent's id is recorded in detail for traceability.
        detail: `released from agent ${agentUserId}`,
      });
      if (res.changed) released += 1;
    } catch {
      // Best-effort: a concurrent transition on this one row shouldn't abort the sweep.
    }
  }
  return released;
}

/*
 * ── H-2 inbox reads ─────────────────────────────────────────────────────────
 * The per-client Inbox. A conversation belongs to a client iff the CANONICAL row
 * (most recently synced, mirroring getWorkflowByN8nId) of its n8n_workflow_id is
 * assigned to that client — so a conversation of a client-UNASSIGNED workflow (or
 * one with no synced workflow) appears in NO inbox. Every read is tenant-scoped and
 * takes the clientId as a data-layer scope (the web layer authorizes access first).
 */

/** A conversation as a row in the per-client inbox list. */
export interface InboxConversationRow {
  id: string;
  conversation_ref: string;
  n8n_workflow_id: string;
  mode: ConversationMode;
  assigned_agent_user_id: string | null;
  assigned_agent_name: string | null;
  workflow_name: string | null;
  last_message_text: string | null;
  last_message_sender: MessageSender | null;
  last_message_content_type: string | null;
  last_message_at: Date | null;
  created_at: Date;
  /** When it last entered 'pending' (for the pending-age label); null if never. */
  pending_since: Date | null;
  /** ACTIVE iff the last customer message is within ACTIVITY_WINDOW_HOURS (SQL-computed). */
  active: boolean;
}

// The canonical-workflow lateral, shared by the inbox reads: resolves one workflow
// row per n8n id (most recently synced) and exposes its client_id + name.
const CANONICAL_WORKFLOW_LATERAL = `
  SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id, w.name AS workflow_name
    FROM workflows w
   WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
   ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST`;

/** A single conversation with its workflow + assigned-agent names, for the thread. */
export interface InboxConversationDetail extends ConversationRow {
  workflow_name: string | null;
  assigned_agent_name: string | null;
}

/**
 * Resolve a conversation for the thread view — ONLY if it belongs to this client
 * (its canonical workflow is assigned there) and this tenant. Returns null
 * otherwise, so a direct-URL probe of another client's conversation → not-found.
 */
export async function getConversationForClient(
  tenantId: string,
  clientId: string,
  conversationId: string,
): Promise<InboxConversationDetail | null> {
  const r = await query<InboxConversationDetail>(
    `SELECT c.*, cw.workflow_name, u.name AS assigned_agent_name
       FROM conversations c
       JOIN LATERAL (${CANONICAL_WORKFLOW_LATERAL}) cw ON cw.client_id = $2
       LEFT JOIN "user" u ON u.id = c.assigned_agent_user_id
      WHERE c.tenant_id = $1 AND c.id = $3`,
    [tenantId, clientId, conversationId],
  );
  return r.rows[0] ?? null;
}

/*
 * ── H-6 per-workflow inbox reads ────────────────────────────────────────────
 * The Inbox is now a per-WORKFLOW section (H-6 consolidation). These mirror the
 * per-client reads but scope by n8n_workflow_id. Client-level reads remain for the
 * attention queue (pending+human across the client).
 */

/**
 * Is this workflow HANDOFF-ACTIVE? True iff it has a registered webhook (enabled or
 * not) OR any handoff_messages exist for its conversations. One cheap query — call
 * once per page load, never per row.
 */
export async function isWorkflowHandoffActive(
  tenantId: string,
  n8nWorkflowId: string,
): Promise<boolean> {
  const r = await query<{ active: boolean }>(
    `SELECT (
       EXISTS (SELECT 1 FROM handoff_webhooks w
                WHERE w.tenant_id = $1 AND w.n8n_workflow_id = $2)
       OR EXISTS (SELECT 1 FROM handoff_messages hm
                    JOIN conversations c ON c.id = hm.conversation_id
                   WHERE c.tenant_id = $1 AND c.n8n_workflow_id = $2)
     ) AS active`,
    [tenantId, n8nWorkflowId],
  );
  return r.rows[0]?.active ?? false;
}

/**
 * A workflow's conversations for the per-workflow inbox list, optionally filtered to
 * one mode. Same row shape + pending-first sort as the client list; scoped by
 * n8n_workflow_id (no client join needed — the web layer already authorized the
 * workflow under its client).
 */
export async function listConversationsForWorkflow(
  tenantId: string,
  n8nWorkflowId: string,
  opts: { mode?: ConversationMode } = {},
): Promise<InboxConversationRow[]> {
  // $3 = the activity window (hours); computed as a boolean in SQL so polling naturally
  // flips a card at the 24h boundary. null last_user_message_at ⇒ INACTIVE (COALESCE).
  const params: unknown[] = [tenantId, n8nWorkflowId, ACTIVITY_WINDOW_HOURS];
  let modeFilter = '';
  if (opts.mode) {
    params.push(opts.mode);
    modeFilter = `AND c.mode = $4`;
  }
  const r = await query<InboxConversationRow>(
    `SELECT
       c.id, c.conversation_ref, c.n8n_workflow_id, c.mode,
       c.assigned_agent_user_id, c.last_message_at, c.created_at,
       cw.workflow_name,
       u.name AS assigned_agent_name,
       lm.text AS last_message_text,
       lm.sender AS last_message_sender,
       lm.content_type AS last_message_content_type,
       ps.pending_since,
       COALESCE(c.last_user_message_at >= now() - make_interval(hours => $3::int), false) AS active
     FROM conversations c
     LEFT JOIN LATERAL (${CANONICAL_WORKFLOW_LATERAL}) cw ON true
     LEFT JOIN "user" u ON u.id = c.assigned_agent_user_id
     LEFT JOIN LATERAL (
       SELECT text, sender, content_type
         FROM handoff_messages hm
        WHERE hm.conversation_id = c.id
        ORDER BY hm.occurred_at DESC, hm.id DESC
        LIMIT 1
     ) lm ON true
     LEFT JOIN LATERAL (
       SELECT created_at AS pending_since
         FROM conversation_mode_transitions t
        WHERE t.conversation_id = c.id AND t.to_mode = 'pending'
        ORDER BY t.created_at DESC
        LIMIT 1
     ) ps ON true
     WHERE c.tenant_id = $1 AND c.n8n_workflow_id = $2 ${modeFilter}
     ORDER BY (c.mode = 'pending') DESC, c.last_message_at DESC NULLS LAST, c.created_at DESC`,
    params,
  );
  return r.rows;
}

/** Latest escalation reason (reason_code + detail of the most recent bot→pending
 * transition) for the given conversations — ONE batched query for the visible pending
 * page only, never a per-card lateral. Returns a map keyed by conversation id. */
export interface EscalationReasonRow {
  conversation_id: string;
  reason_code: string | null;
  detail: string | null;
}
export async function getLatestEscalationReasons(
  tenantId: string,
  conversationIds: string[],
): Promise<Map<string, EscalationReasonRow>> {
  if (conversationIds.length === 0) return new Map();
  const r = await query<EscalationReasonRow>(
    `SELECT DISTINCT ON (conversation_id) conversation_id, reason_code, detail
       FROM conversation_mode_transitions
      WHERE tenant_id = $1 AND conversation_id = ANY($2::uuid[]) AND to_mode = 'pending'
      ORDER BY conversation_id, created_at DESC`,
    [tenantId, conversationIds],
  );
  return new Map(r.rows.map((row) => [row.conversation_id, row]));
}

/** Count of a workflow's pending conversations (per-workflow inbox Pending chip). */
export async function countPendingForWorkflow(
  tenantId: string,
  n8nWorkflowId: string,
): Promise<number> {
  const r = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM conversations
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND mode = 'pending'`,
    [tenantId, n8nWorkflowId],
  );
  return r.rows[0]?.count ?? 0;
}

/**
 * Resolve a conversation for the per-workflow thread — ONLY if it belongs to this
 * workflow + tenant. Returns null otherwise (direct-URL probe → not-found). The
 * caller guards that conversationId is a UUID before calling.
 */
export async function getConversationForWorkflow(
  tenantId: string,
  n8nWorkflowId: string,
  conversationId: string,
): Promise<InboxConversationDetail | null> {
  const r = await query<InboxConversationDetail>(
    `SELECT c.*, cw.workflow_name, u.name AS assigned_agent_name
       FROM conversations c
       LEFT JOIN LATERAL (${CANONICAL_WORKFLOW_LATERAL}) cw ON true
       LEFT JOIN "user" u ON u.id = c.assigned_agent_user_id
      WHERE c.tenant_id = $1 AND c.n8n_workflow_id = $2 AND c.id = $3`,
    [tenantId, n8nWorkflowId, conversationId],
  );
  return r.rows[0] ?? null;
}

/**
 * The live handoff conversation id for a (workflow, conversation_ref), or null if none
 * exists. Lets the execution-detail conversation link target the inbox drawer (?c=<id>)
 * when the conversation is a live handoff one, and fall back to the derived view otherwise.
 */
export async function getHandoffConversationIdByRef(
  tenantId: string,
  n8nWorkflowId: string,
  conversationRef: string,
): Promise<string | null> {
  const r = await query<{ id: string }>(
    `SELECT id FROM conversations
      WHERE tenant_id = $1 AND n8n_workflow_id = $2 AND conversation_ref = $3
      LIMIT 1`,
    [tenantId, n8nWorkflowId, conversationRef],
  );
  return r.rows[0]?.id ?? null;
}

/** A thread message with its sender agent's display name (for human_agent bubbles). */
export interface ThreadMessageRow extends HandoffMessageRow {
  agent_name: string | null;
}

/**
 * A conversation's messages oldest→newest for the thread view, each with the
 * sender agent's name joined (null unless sender='human_agent'). Tenant-scoped.
 */
export async function listThreadMessages(
  tenantId: string,
  conversationId: string,
): Promise<ThreadMessageRow[]> {
  const r = await query<ThreadMessageRow>(
    `SELECT hm.*, u.name AS agent_name
       FROM handoff_messages hm
       LEFT JOIN "user" u ON u.id = hm.agent_user_id
      WHERE hm.tenant_id = $1 AND hm.conversation_id = $2
      ORDER BY hm.occurred_at ASC, hm.id ASC`,
    [tenantId, conversationId],
  );
  return r.rows;
}

/** How many of this client's conversations are 'pending' — the small static
 * "N pending across workflows" stat on the client overview (H-7; no attention surface). */
export async function countPendingForClient(tenantId: string, clientId: string): Promise<number> {
  const r = await query<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM conversations c
       JOIN LATERAL (${CANONICAL_WORKFLOW_LATERAL}) cw ON cw.client_id = $2
      WHERE c.tenant_id = $1 AND c.mode = 'pending'`,
    [tenantId, clientId],
  );
  return r.rows[0]?.count ?? 0;
}
