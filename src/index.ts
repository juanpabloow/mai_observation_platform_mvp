import { config } from './config.js';
import { logger } from './logger.js';

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
};

logger.info({ logLevel: config.LOG_LEVEL }, 'starting worker');
logger.info({ config: redactedConfig }, 'loaded configuration');

// Keep the process alive. The ingestion/polling loop will be added in a later
// step; for now this no-op interval prevents the worker from exiting.
const keepAlive = setInterval(() => {
  /* intentionally empty until the polling loop lands */
}, 60_000);

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutting down worker');
  clearInterval(keepAlive);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
