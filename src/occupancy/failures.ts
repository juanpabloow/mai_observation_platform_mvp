import { logger } from '../logger.js';

/**
 * JP-8 — the occupancy rollup is a DERIVED cache: a failure to keep it current must NEVER break the
 * underlying write (an appointment, a payment, an hours change). Dirty-marking and recompute route
 * their errors here — swallowed, counted, logged — exactly like the pipeline's `recordPipelineFailure`.
 * The count is an in-memory, per-process health signal that resets on restart.
 */
let failureCount = 0;

export function recordOccupancyFailure(context: Record<string, unknown>, err?: unknown): void {
  failureCount += 1;
  logger.warn({ ...context, err: err ? String(err) : undefined }, 'occupancy: operation failed (swallowed; counted)');
}

export function getOccupancyFailureCount(): number {
  return failureCount;
}
