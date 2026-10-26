import { query } from '../db/client.js';
import { logger } from '../logger.js';
import { transitionMode } from '../db/repositories/handoff.js';
import { recordPipelineFailure } from '../pipeline/failures.js';

/**
 * JP-2 — AUTO-RETURN sweep + its worker-interval wrapper (mirrors pipeline/autoLost.ts: reentry
 * guard, `.unref()`, fail-safe, per-row re-verify under the transitionMode row lock).
 *
 * A conversation out of the bot's hands returns to the bot after the per-client
 * `inbox_settings.auto_return_minutes` (default 60; 0 = never):
 *  - PENDING (escalated, nobody took it): once it has been pending for the threshold (since it last
 *    entered 'pending').
 *  - HUMAN (a person took it): once there has been NO human-agent message for the threshold, measured
 *    from the last human-agent message — or from when they took it, if they never wrote. An active
 *    human conversation (a recent agent message) is never taken away.
 *
 * The transition is source 'platform_rule', reason_code 'auto_return' (actor = system), so it leaves
 * the attention queue (mode → bot), writes exactly ONE audit row (transitionMode is idempotent + row-
 * locked → safe under concurrency, the event/Inbox line is written once), and the bot sends nothing
 * proactively — it simply answers the customer's next message with the full history.
 */
const DEFAULT_AUTORETURN_INTERVAL_SECONDS = 120;
const DEFAULT_MINUTES = 60;

let handle: NodeJS.Timeout | null = null;
let running = false;

export interface AutoReturnResult {
  scanned: number;
  returned: number;
}

/**
 * The staleness predicate, shared by the candidate scan and the per-row re-verify so they can never
 * drift. `$1` = the conversation alias is `c`; resolves the client via the canonical workflow row
 * (most recently synced, like getWorkflowByN8nId) to read inbox_settings, COALESCEing the default.
 */
const STALE_WHERE = `
  c.mode IN ('pending', 'human')
  AND COALESCE(s.auto_return_minutes, ${DEFAULT_MINUTES}) > 0
  AND (
    (c.mode = 'pending' AND (
       SELECT max(t.created_at) FROM conversation_mode_transitions t
        WHERE t.tenant_id = c.tenant_id AND t.conversation_id = c.id AND t.to_mode = 'pending'
     ) <= now() - make_interval(mins => COALESCE(s.auto_return_minutes, ${DEFAULT_MINUTES})))
    OR
    (c.mode = 'human' AND COALESCE(
       (SELECT max(hm.occurred_at) FROM handoff_messages hm
          WHERE hm.tenant_id = c.tenant_id AND hm.conversation_id = c.id AND hm.sender = 'human_agent'),
       (SELECT max(t.created_at) FROM conversation_mode_transitions t
          WHERE t.tenant_id = c.tenant_id AND t.conversation_id = c.id AND t.to_mode = 'human')
     ) <= now() - make_interval(mins => COALESCE(s.auto_return_minutes, ${DEFAULT_MINUTES})))
  )`;

const CANONICAL_CLIENT = `
  LEFT JOIN LATERAL (
    SELECT DISTINCT ON (w.n8n_workflow_id) w.client_id
      FROM workflows w
     WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id
     ORDER BY w.n8n_workflow_id, w.last_synced_at DESC NULLS LAST
  ) cw ON true
  LEFT JOIN inbox_settings s ON s.tenant_id = c.tenant_id AND s.client_id = cw.client_id`;

/** The resolved threshold (minutes) for one conversation — for the audit detail + Inbox label. */
async function minutesFor(tenantId: string, conversationId: string): Promise<number> {
  const r = await query<{ minutes: number }>(
    `SELECT COALESCE(s.auto_return_minutes, ${DEFAULT_MINUTES}) AS minutes
       FROM conversations c ${CANONICAL_CLIENT}
      WHERE c.tenant_id = $1 AND c.id = $2`,
    [tenantId, conversationId],
  );
  return r.rows[0]?.minutes ?? DEFAULT_MINUTES;
}

/**
 * Re-verify ONE conversation is still stale, then return it to the bot. The candidate scan may be a
 * few seconds stale (a human just took or just wrote); this re-reads the predicate immediately before
 * the transition, and transitionMode's row lock + `expectedFrom` finalise it (a concurrent take/hand-
 * back makes it a no-op, never a wrong return). Returns true iff it actually moved.
 */
export async function autoReturnIfStale(tenantId: string, conversationId: string): Promise<boolean> {
  const still = await query<{ mode: 'pending' | 'human' }>(
    `SELECT c.mode FROM conversations c ${CANONICAL_CLIENT}
      WHERE c.tenant_id = $1 AND c.id = $2 AND ${STALE_WHERE}`,
    [tenantId, conversationId],
  );
  const row = still.rows[0];
  if (!row) return false;
  const minutes = await minutesFor(tenantId, conversationId);
  const res = await transitionMode(tenantId, conversationId, 'bot', {
    source: 'platform_rule',
    reasonCode: 'auto_return',
    detail: String(minutes), // the threshold in minutes — the Inbox line renders it ("tras 1 h")
    expectedFrom: row.mode, // no-op if a person took/handed it back since the scan
  });
  return res.changed;
}

/** Run the sweep once. Cheap set-based candidate scan, then re-verify + return each under its lock. */
export async function runAutoReturnOnce(opts: { tenantId?: string } = {}): Promise<AutoReturnResult> {
  const params: unknown[] = [];
  let scope = '';
  if (opts.tenantId) {
    params.push(opts.tenantId);
    scope = `AND c.tenant_id = $1`;
  }
  const candidates = await query<{ id: string; tenant_id: string }>(
    `SELECT c.id, c.tenant_id
       FROM conversations c ${CANONICAL_CLIENT}
      WHERE ${STALE_WHERE} ${scope}`,
    params,
  );
  let returned = 0;
  for (const c of candidates.rows) {
    try {
      if (await autoReturnIfStale(c.tenant_id, c.id)) returned += 1;
    } catch (err) {
      recordPipelineFailure({ job: 'auto-return', conversationId: c.id }, err);
    }
  }
  return { scanned: candidates.rows.length, returned };
}

async function runCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const res = await runAutoReturnOnce();
    if (res.returned > 0) logger.info(res, 'handoff auto-return: returned stale conversations to the bot');
  } catch (err) {
    recordPipelineFailure({ job: 'auto-return-cycle' }, err);
  } finally {
    running = false;
  }
}

/** Start the periodic sweep (idempotent; shares the worker process; the timer never holds it open). */
export function startAutoReturn(env: NodeJS.ProcessEnv = process.env): void {
  if (handle) return;
  const secs = Number(env.HANDOFF_AUTORETURN_INTERVAL_SECONDS) || DEFAULT_AUTORETURN_INTERVAL_SECONDS;
  handle = setInterval(() => void runCycle(), secs * 1000);
  handle.unref();
  logger.info({ intervalSeconds: secs }, 'handoff auto-return job started');
}

export function stopAutoReturn(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
