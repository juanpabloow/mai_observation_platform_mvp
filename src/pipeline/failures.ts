import { logger } from '../logger.js';

/**
 * PL-1 — pipeline failure counter. Mirrors attribution's `recordAttributionFailure`: a
 * per-process, in-memory count plus a warn log. Pipeline hooks are FAIL-SAFE — a pipeline error
 * never fails the underlying message/booking/cancel/complete write — so every swallowed error is
 * counted here and healed by the reconciliation sweep (auto-lost) or a later backfill. Resets on
 * restart (a volatile health signal, like attribution's).
 */
let failureCount = 0;

export function recordPipelineFailure(context: Record<string, unknown>, err?: unknown): void {
  failureCount += 1;
  logger.warn({ ...context, err: err ? String(err) : undefined }, 'pipeline: operation failed (swallowed; counted)');
}

export function getPipelineFailureCount(): number {
  return failureCount;
}
