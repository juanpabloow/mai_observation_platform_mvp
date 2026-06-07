import { pino } from 'pino';
import { config } from './config.js';

/**
 * Application-wide structured logger.
 * Emits newline-delimited JSON at the configured log level.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
});
