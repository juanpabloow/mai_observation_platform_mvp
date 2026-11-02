import { config } from './config.js';
import { closePool } from './db/client.js';
import { logger } from './logger.js';
import { startWorker, stopWorker } from './ingestion/worker.js';
import { startAttributionReconciliation, stopAttributionReconciliation } from './attribution/reconcile.js';
import { startCoverReconcile, stopCoverReconcile } from './attribution/coverReconcile.js';
import { startAutoLost, stopAutoLost } from './pipeline/autoLost.js';
import { startAutoReturn, stopAutoReturn } from './handoff/autoReturn.js';
import { startOccupancyNightly, startOccupancyRollup, stopOccupancyNightly, stopOccupancyRollup } from './occupancy/rollup.js';

/**
 * Mask the password embedded in a PostgreSQL connection string while keeping
 * the rest of the URL (host, port, database) readable for debugging.
 */
function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return '***REDACTED***';
  }
}

/** Config view that is safe to log — secrets are redacted. */
const redactedConfig = {
  ...config,
  DATABASE_URL: redactDatabaseUrl(config.DATABASE_URL),
  DB_PASSWORD: '***REDACTED***',
  ENCRYPTION_KEY: '***REDACTED***',
  ...(config.TEST_N8N_API_KEY ? { TEST_N8N_API_KEY: '***REDACTED***' } : {}),
};

logger.info({ logLevel: config.LOG_LEVEL }, 'starting worker');
logger.info({ config: redactedConfig }, 'loaded configuration');

startWorker();
// AT-1 §3: attribution reconciliation shares THIS worker (not a new service) — a light
// interval that mops up any referral message whose live attribution didn't land. Fail-safe:
// it never throws into the ingestion loop (see runAttributionReconcileOnce).
startAttributionReconciliation();
// AT-2c: ad-cover reconciliation shares THIS worker too — it downloads the signed Meta thumbnail/
// image urls ingestion queued on ads into the public bucket, and retries transient failures. It
// no-ops unless the public image store (R2) is configured for this process. Fail-safe like the above.
startCoverReconcile();
// PL-1 §2: the sales-pipeline auto-lost sweep shares THIS worker too — it loses OPEN lead/qualified
// sales the business answered last and that went unanswered past auto_lost_after_hours. Fail-safe +
// re-checks each candidate under its row lock. Default 15-min interval (PIPELINE_AUTOLOST_INTERVAL_SECONDS).
startAutoLost();
// JP-2: the handoff auto-return sweep shares THIS worker too — it hands a conversation back to the
// bot once it has been pending (unattended) or human (no agent message) past the per-client
// inbox_settings.auto_return_minutes. Fail-safe + re-checks each candidate under its row lock.
// Default 2-min interval (HANDOFF_AUTORETURN_INTERVAL_SECONDS).
startAutoReturn();
// JP-8 §1: the staff-occupancy rollup shares THIS worker too. The DRAIN job recomputes the (staff,
// day) rows that appointment/payment/schedule writes enqueued (default 2-min, OCCUPANCY_ROLLUP_
// INTERVAL_SECONDS); the NIGHTLY job re-enqueues the rolling window [−35, +30] (default 24-h,
// OCCUPANCY_NIGHTLY_INTERVAL_SECONDS, plus once at boot). Both fail-safe (an error is counted, never
// thrown) and only ever rebuild a DERIVED cache, so they never affect a booking or a payment.
startOccupancyRollup();
startOccupancyNightly();
// El barrido de eliminaciones de Reuniones NO va aquí: tiene su propio
// entrypoint (`src/maintenanceMain.ts`) y su propio servicio. Este proceso es
// el de la ingesta de n8n, y mezclarlos haría que reiniciar uno reiniciara el
// otro.

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return; // ignore repeated signals
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker');
  try {
    await stopWorker();
    await stopAttributionReconciliation();
    await stopCoverReconcile();
    stopAutoLost();
    stopAutoReturn();
    stopOccupancyRollup();
    stopOccupancyNightly();
    await closePool();
  } catch (err) {
    logger.error({ err }, 'error during shutdown');
  } finally {
    logger.info('shutdown complete');
    process.exit(0);
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
