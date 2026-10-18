import { backfillAttribution } from './backfill.js';
import { recordAttributionFailure } from './ingest.js';
import { logger } from '../logger.js';

/**
 * AT-1 §3 — worker reconciliation. Live ingestion is synchronous + fail-safe, so this only mops
 * up the rare post-commit failure and any referral messages that predate capture. It runs the
 * SAME engine as the backfill (idempotent: a quiet pass writes nothing), on an interval.
 *
 * INTERVAL: 300s (ATTRIBUTION_RECONCILE_INTERVAL_SECONDS) — attribution is secondary and live
 * capture already covers the hot path, so 5 min is responsive without load. .unref() so it never
 * keeps the process alive on its own.
 */
export const DEFAULT_RECONCILE_INTERVAL_SECONDS = 300;

let handle: NodeJS.Timeout | null = null;
let running = false;

export async function runAttributionReconcileOnce(): Promise<void> {
  if (running) return; // never overlap passes
  running = true;
  try {
    const s = await backfillAttribution({ apply: true });
    if (s.touchesWritten > 0 || s.originsSet > 0 || s.invalidReferrals > 0) {
      logger.info(
        { touchesWritten: s.touchesWritten, originsSet: s.originsSet, invalid: s.invalidReferrals },
        'AT-1: reconciliation pass',
      );
    }
  } catch (err) {
    recordAttributionFailure({ job: 'attribution-reconcile' }, err);
  } finally {
    running = false;
  }
}

export function startAttributionReconciliation(env: NodeJS.ProcessEnv = process.env): void {
  if (handle) return;
  const secs = Number(env.ATTRIBUTION_RECONCILE_INTERVAL_SECONDS) || DEFAULT_RECONCILE_INTERVAL_SECONDS;
  handle = setInterval(() => void runAttributionReconcileOnce(), secs * 1000);
  handle.unref();
  logger.info({ intervalSeconds: secs }, 'AT-1: attribution reconciliation started');
}

export async function stopAttributionReconciliation(): Promise<void> {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
