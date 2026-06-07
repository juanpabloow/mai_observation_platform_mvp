import { config } from './config.js';
import { closePool } from './db/client.js';
import { logger } from './logger.js';
import { startWorker, stopWorker } from './ingestion/worker.js';

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

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return; // ignore repeated signals
  }
  shuttingDown = true;
  logger.info({ signal }, 'shutting down worker');
  try {
    await stopWorker();
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
