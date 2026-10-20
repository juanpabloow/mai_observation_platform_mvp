import { captureAdCoversOnce } from './coverCapture.js';
import { isPublicImageStoreConfigured } from '../storage/publicImageStore.js';
import { recordAttributionFailure } from './ingest.js';
import { logger } from '../logger.js';

/**
 * AT-2c — worker cover reconciliation. Ingestion queues the signed Meta thumbnail/image url on the
 * ad (never fetching it on the message hot path); this loop downloads the queued urls into the public
 * bucket and retries transient failures while the signed url is still valid. Mirrors the attribution
 * reconcile (interval + reentry guard + .unref()). Disabled when the public image store isn't
 * configured for this process, so it never spins uselessly.
 *
 * INTERVAL: 300s (COVER_RECONCILE_INTERVAL_SECONDS). First capture of a new ad lands within one
 * interval; signed urls last days, so a few-minute delay is immaterial.
 */
export const DEFAULT_COVER_RECONCILE_INTERVAL_SECONDS = 300;

let handle: NodeJS.Timeout | null = null;
let running = false;

export async function runCoverReconcileOnce(): Promise<void> {
  if (running) return; // never overlap passes
  if (!isPublicImageStoreConfigured) return; // no public bucket on this process → nothing to do
  running = true;
  try {
    const c = await captureAdCoversOnce();
    if (c.stored > 0 || c.refused > 0 || c.failed > 0 || c.superseded > 0) {
      logger.info({ ...c }, 'AT-2c: ad cover reconciliation pass');
    }
  } catch (err) {
    recordAttributionFailure({ job: 'cover-reconcile' }, err);
  } finally {
    running = false;
  }
}

export function startCoverReconcile(env: NodeJS.ProcessEnv = process.env): void {
  if (handle) return;
  if (!isPublicImageStoreConfigured) {
    logger.info('AT-2c: ad cover reconciliation disabled (public image store not configured)');
    return;
  }
  const secs = Number(env.COVER_RECONCILE_INTERVAL_SECONDS) || DEFAULT_COVER_RECONCILE_INTERVAL_SECONDS;
  handle = setInterval(() => void runCoverReconcileOnce(), secs * 1000);
  handle.unref();
  logger.info({ intervalSeconds: secs }, 'AT-2c: ad cover reconciliation started');
}

export async function stopCoverReconcile(): Promise<void> {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
