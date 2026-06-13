import { logger } from '../logger.js';
import { buildExecutionResolver, extractMapping } from '../n8n/executionData.js';
import {
  listConversationMappings,
  listWorkflowsWithConversationMappings,
  type ConversationMappingRow,
} from '../db/repositories/fieldMappings.js';
import {
  getExecutionsForDerivationByIds,
  listExecutionsForDerivationPage,
  type ExecutionForDerivation,
} from '../db/repositories/executions.js';
import { deleteTurnByExecution, upsertTurn } from '../db/repositories/conversationTurns.js';
import type { ConversationRole } from '../db/types.js';

/**
 * Turn derivation: apply a workflow's conversation mappings to an execution to
 * reconstruct a chat turn. The skip logic here is the critical correctness
 * concern — a wrong skip silently garbles conversations rather than crashing.
 *
 * SKIP (not a turn) when: no conversation mappings, OR the required
 * conversation_id / user_message roles aren't configured, OR either extracts to
 * a missing/empty/whitespace-only value. That last rule is what excludes status
 * callbacks and other non-message executions — they carry no user_message.
 */

/** A derived turn (pure result of applying mappings to one execution). */
export interface DerivedTurn {
  /** Thread key — present + non-empty (trimmed: it's an identifier). */
  conversationId: string;
  contactName: string | null;
  /** The user's message — present + non-empty (stored as extracted). */
  userMessage: string;
  /** The AI reply, or null if none was captured (a valid partial turn). */
  aiResponse: string | null;
  turnTimestamp: Date;
}

/** Coerce an extracted value to text, or null if absent (undefined/null). */
function toText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A text value that is present and not whitespace-only. */
function meaningful(text: string | null): text is string {
  return text !== null && text.trim() !== '';
}

function roleMap(
  mappings: ConversationMappingRow[],
): Map<ConversationRole, ConversationMappingRow> {
  const map = new Map<ConversationRole, ConversationMappingRow>();
  for (const row of mappings) map.set(row.role, row);
  return map;
}

/**
 * PURE: derive a turn from an execution given its workflow's conversation
 * mappings, or null if the execution is not a real message turn. No DB access.
 */
export function deriveTurnForExecution(
  execution: ExecutionForDerivation,
  mappings: ConversationMappingRow[],
): DerivedTurn | null {
  if (mappings.length === 0) return null;

  const byRole = roleMap(mappings);
  const convMap = byRole.get('conversation_id');
  const userMap = byRole.get('user_message');
  // Both required roles must be configured, else we can't form a turn.
  if (!convMap || !userMap) return null;

  const resolver = buildExecutionResolver(execution.raw_data);
  const conversationId = toText(extractMapping(resolver, convMap.node_name, convMap.json_path));
  const userMessage = toText(extractMapping(resolver, userMap.node_name, userMap.json_path));

  // The skip signal: a non-message execution (e.g. status callback) extracts no
  // user_message (and often no conversation_id). Empty/whitespace counts as missing.
  if (!meaningful(conversationId) || !meaningful(userMessage)) return null;

  const aiMap = byRole.get('ai_response');
  const nameMap = byRole.get('contact_name');
  const aiResponse = aiMap
    ? toText(extractMapping(resolver, aiMap.node_name, aiMap.json_path))
    : null;
  const contactName = nameMap
    ? toText(extractMapping(resolver, nameMap.node_name, nameMap.json_path))
    : null;

  return {
    // conversation_id is a thread key — trim so stray whitespace can't silently
    // split one thread into two. Message content is stored as-is (fidelity).
    conversationId: conversationId.trim(),
    contactName: meaningful(contactName) ? contactName : null,
    userMessage,
    aiResponse: meaningful(aiResponse) ? aiResponse : null,
    turnTimestamp: execution.started_at,
  };
}

export type DeriveOutcome = 'upserted' | 'deleted' | 'skipped';

/**
 * Derive + persist one execution's turn: upsert it if it's a turn, otherwise
 * delete any stale turn for that execution (covers a mapping being removed since
 * the last derive). Tenant_id always comes from the execution row.
 */
export async function deriveAndPersistTurn(
  execution: ExecutionForDerivation,
  mappings: ConversationMappingRow[],
): Promise<DeriveOutcome> {
  const turn = deriveTurnForExecution(execution, mappings);
  if (turn) {
    await upsertTurn({
      tenantId: execution.tenant_id,
      n8nWorkflowId: execution.n8n_workflow_id,
      executionId: execution.id,
      conversationId: turn.conversationId,
      contactName: turn.contactName,
      userMessage: turn.userMessage,
      aiResponse: turn.aiResponse,
      turnTimestamp: turn.turnTimestamp,
    });
    return 'upserted';
  }
  const deleted = await deleteTurnByExecution({
    tenantId: execution.tenant_id,
    executionId: execution.id,
  });
  return deleted ? 'deleted' : 'skipped';
}

export interface DeriveCounts {
  /** Executions examined. */
  processed: number;
  /** Turns inserted/updated. */
  upserted: number;
  /** Stale turns removed (execution no longer a turn). */
  deleted: number;
  /** Non-turn executions with nothing to remove. */
  skipped: number;
  /** Per-execution derivation failures (logged + skipped, never fatal). */
  errors: number;
}

function emptyCounts(): DeriveCounts {
  return { processed: 0, upserted: 0, deleted: 0, skipped: 0, errors: 0 };
}

/**
 * DERIVE-ON-INGEST entry point: derive turns for a set of just-ingested
 * execution ids (within one tenant). Loads each execution's workflow mappings
 * (cached per workflow); workflows without conversation mappings are skipped
 * cheaply. A failure on one execution is logged and skipped — never thrown.
 */
export async function deriveTurnsForExecutionIds(params: {
  tenantId: string;
  executionIds: string[];
}): Promise<DeriveCounts> {
  const counts = emptyCounts();
  if (params.executionIds.length === 0) return counts;

  const executions = await getExecutionsForDerivationByIds({
    tenantId: params.tenantId,
    ids: params.executionIds,
  });

  const mappingCache = new Map<string, ConversationMappingRow[]>();
  for (const execution of executions) {
    counts.processed += 1;
    try {
      let mappings = mappingCache.get(execution.n8n_workflow_id);
      if (!mappings) {
        mappings = await listConversationMappings({
          tenantId: params.tenantId,
          n8nWorkflowId: execution.n8n_workflow_id,
        });
        mappingCache.set(execution.n8n_workflow_id, mappings);
      }
      if (mappings.length === 0) {
        counts.skipped += 1; // workflow has no conversation mappings
        continue;
      }
      counts[await deriveAndPersistTurn(execution, mappings)] += 1;
    } catch (err) {
      counts.errors += 1;
      logger.error(
        { err, executionId: execution.id, workflowId: execution.n8n_workflow_id },
        'turn derivation failed for execution; skipping',
      );
    }
  }
  return counts;
}

export interface BackfillCounts extends DeriveCounts {
  /** Workflows that had conversation mappings and were processed. */
  workflows: number;
}

/** Page size when walking a workflow's executions during backfill. */
const BACKFILL_BATCH = 200;

/**
 * BACKFILL entry point: walk ALL executions for every workflow that has
 * conversation mappings (optionally scoped to one workflow) and derive/upsert
 * their turns. Idempotent (UNIQUE execution_id) and re-runnable.
 */
export async function backfillTurns(filterWorkflowId?: string): Promise<BackfillCounts> {
  const targets = await listWorkflowsWithConversationMappings(filterWorkflowId);
  const counts: BackfillCounts = { ...emptyCounts(), workflows: 0 };

  for (const target of targets) {
    const mappings = await listConversationMappings({
      tenantId: target.tenant_id,
      n8nWorkflowId: target.n8n_workflow_id,
    });
    if (mappings.length === 0) continue; // race: mappings removed between calls
    counts.workflows += 1;

    let afterId: string | null = null;
    for (;;) {
      const page = await listExecutionsForDerivationPage({
        tenantId: target.tenant_id,
        n8nWorkflowId: target.n8n_workflow_id,
        afterId,
        limit: BACKFILL_BATCH,
      });
      if (page.length === 0) break;

      for (const execution of page) {
        counts.processed += 1;
        try {
          counts[await deriveAndPersistTurn(execution, mappings)] += 1;
        } catch (err) {
          counts.errors += 1;
          logger.error(
            { err, executionId: execution.id, workflowId: execution.n8n_workflow_id },
            'turn derivation failed during backfill; skipping',
          );
        }
      }

      afterId = page[page.length - 1].id;
      if (page.length < BACKFILL_BATCH) break;
    }
  }

  return counts;
}
