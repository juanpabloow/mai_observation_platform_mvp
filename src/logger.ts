import { pino } from 'pino';
import { runtimeEnv } from './runtimeEnv.js';

/**
 * Application-wide structured logger.
 * Emits newline-delimited JSON at the configured log level.
 */
export const logger = pino({
  level: runtimeEnv.LOG_LEVEL,
});
