import { query } from '../db/client.js';
import { logger } from '../logger.js';
import { autoLoseIfUnanswered } from './engine.js';
import { recordPipelineFailure } from './failures.js';

/**
 * PL-1 §2 — the auto-lost sweep + its worker-interval wrapper (mirrors attribution's reconcile.ts:
 * reentry guard, `.unref()`, fail-safe). An OPEN lead/qualified sale whose conversation's LAST
 * message is from the business (bot/human agent) and unanswered for auto_lost_after_hours is lost
 * (no_respondio, actor system). Never when the CUSTOMER spoke last (the business's failure, counted
 * separately as "sin respuesta del negocio"), and NEVER a booked sale. The 15-min default suits an
 * hours-granularity threshold; override with PIPELINE_AUTOLOST_INTERVAL_SECONDS.
 */
const DEFAULT_AUTOLOST_INTERVAL_SECONDS = 900;

let handle: NodeJS.Timeout | null = null;
let running = false;

export interface AutoLostResult {
  scanned: number;
  lost: number;
}

/**
 * Run the sweep once. Selects candidates with a cheap set-based query, then re-verifies + loses each
 * one under its own row lock (so a reply or booking since selection is respected). Per-opportunity
 * failures are counted, never thrown — one bad row never aborts the batch. `tenantId` scopes it (the
 * backfill/tests run it per tenant).
 */
export async function runAutoLostOnce(opts: { tenantId?: string } = {}): Promise<AutoLostResult> {
  const params: unknown[] = [];
  let scope = '';
  if (opts.tenantId) {
    params.push(opts.tenantId);
    scope = `AND o.tenant_id = $1`;
  }
  const candidates = await query<{ id: string; tenant_id: string; client_id: string }>(
    `SELECT o.id, o.tenant_id, o.client_id
       FROM opportunities o
       JOIN LATERAL (
         SELECT hm.sender, hm.created_at
           FROM handoff_messages hm
          WHERE hm.tenant_id = o.tenant_id AND hm.conversation_id = o.conversation_id
          ORDER BY hm.created_at DESC, hm.id DESC
          LIMIT 1
       ) lm ON true
       LEFT JOIN pipeline_settings ps ON ps.tenant_id = o.tenant_id AND ps.client_id = o.client_id
      WHERE o.status = 'open' AND o.stage IN ('lead', 'qualified') AND o.conversation_id IS NOT NULL
        AND lm.sender IN ('bot', 'human_agent')
        AND lm.created_at <= now() - make_interval(hours => COALESCE(ps.auto_lost_after_hours, 72))
        ${scope}`,
    params,
  );
  let lost = 0;
  for (const c of candidates.rows) {
    try {
      if (await autoLoseIfUnanswered(c.tenant_id, c.client_id, c.id)) lost += 1;
    } catch (err) {
      recordPipelineFailure({ job: 'auto-lost', opportunityId: c.id }, err);
    }
  }
  return { scanned: candidates.rows.length, lost };
}

/**
 * Count open lead/qualified sales whose conversation's last message is from the CUSTOMER — the
 * business never answered. These are explicitly NEVER auto-lost; this count is the "sin respuesta
 * del negocio" signal the dashboard phase surfaces.
 */
export async function countAwaitingBusinessReply(tenantId?: string): Promise<number> {
  const params: unknown[] = [];
  let scope = '';
  if (tenantId) {
    params.push(tenantId);
    scope = `AND o.tenant_id = $1`;
  }
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM opportunities o
       JOIN LATERAL (
         SELECT hm.sender FROM handoff_messages hm
          WHERE hm.tenant_id = o.tenant_id AND hm.conversation_id = o.conversation_id
          ORDER BY hm.created_at DESC, hm.id DESC LIMIT 1
       ) lm ON true
      WHERE o.status = 'open' AND o.stage IN ('lead', 'qualified') AND o.conversation_id IS NOT NULL
        AND lm.sender = 'user' ${scope}`,
    params,
  );
  return r.rows[0]?.n ?? 0;
}

async function runCycle(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const res = await runAutoLostOnce();
    if (res.lost > 0) logger.info(res, 'pipeline auto-lost: swept stale unanswered sales');
  } catch (err) {
    recordPipelineFailure({ job: 'auto-lost-cycle' }, err);
  } finally {
    running = false;
  }
}

/** Start the periodic sweep (idempotent; shares the worker process; the timer never holds it open). */
export function startAutoLost(env: NodeJS.ProcessEnv = process.env): void {
  if (handle) return;
  const secs = Number(env.PIPELINE_AUTOLOST_INTERVAL_SECONDS) || DEFAULT_AUTOLOST_INTERVAL_SECONDS;
  handle = setInterval(() => void runCycle(), secs * 1000);
  handle.unref();
  logger.info({ intervalSeconds: secs }, 'pipeline auto-lost job started');
}

export function stopAutoLost(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
