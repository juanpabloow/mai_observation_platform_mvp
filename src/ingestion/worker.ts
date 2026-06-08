import { config } from '../config.js';
import { logger } from '../logger.js';
import { listActiveConnections } from '../db/repositories/n8nConnections.js';
import { ingestExecutionsForConnection, type IngestResult } from './ingestExecutions.js';
import { syncWorkflowsForConnection, type SyncResult } from './syncWorkflows.js';
import type { N8nConnectionRow } from '../db/types.js';

/**
 * Max connections processed concurrently per cycle. Separate from (and outer to)
 * the per-execution CONCURRENCY inside ingestExecutionsForConnection — keeps one
 * slow connection's n8n from blocking the others.
 */
export const CONNECTION_CONCURRENCY = 5;

let intervalHandle: NodeJS.Timeout | null = null;
let isRunning = false;
let currentCycle: Promise<void> | null = null;
let cycleCount = 0;

interface ConnectionOutcome {
  sync: SyncResult;
  ingest: IngestResult;
}

/** Sync workflows then ingest executions for one connection. */
async function processConnection(connection: N8nConnectionRow): Promise<ConnectionOutcome> {
  const sync = await syncWorkflowsForConnection(connection);
  const ingest = await ingestExecutionsForConnection(connection);
  return { sync, ingest };
}

/** One cycle across all active connections. Never throws (logs instead). */
async function runCycle(): Promise<void> {
  const cycle = ++cycleCount;
  const startedAt = Date.now();

  try {
    const connections = await listActiveConnections();
    logger.info({ cycle, activeConnections: connections.length }, 'ingestion cycle start');

    let processed = 0;
    let totalSynced = 0;
    let totalNew = 0;
    let totalErrors = 0;

    for (let i = 0; i < connections.length; i += CONNECTION_CONCURRENCY) {
      const chunk = connections.slice(i, i + CONNECTION_CONCURRENCY);
      const settled = await Promise.allSettled(chunk.map((c) => processConnection(c)));

      settled.forEach((outcome, idx) => {
        const connection = chunk[idx];
        processed += 1;
        if (outcome.status === 'fulfilled') {
          const { sync, ingest } = outcome.value;
          totalSynced += sync.synced;
          totalNew += ingest.new;
          totalErrors += ingest.errors;
          logger.info(
            {
              cycle,
              connection: connection.name,
              connectionId: connection.id,
              workflowsSynced: sync.synced,
              fetched: ingest.fetched,
              new: ingest.new,
              errors: ingest.errors,
              newCursor: ingest.newCursor,
            },
            'connection processed',
          );
        } else {
          totalErrors += 1;
          logger.error(
            { cycle, connection: connection.name, connectionId: connection.id, err: outcome.reason },
            'connection processing rejected',
          );
        }
      });
    }

    logger.info(
      {
        cycle,
        connectionsProcessed: processed,
        totalWorkflowsSynced: totalSynced,
        totalNew,
        totalErrors,
        durationMs: Date.now() - startedAt,
      },
      'ingestion cycle complete',
    );
  } catch (err) {
    // e.g. listActiveConnections failed — never let a cycle crash the worker.
    logger.error({ cycle, err, durationMs: Date.now() - startedAt }, 'ingestion cycle failed');
  }
}

/** Fire a cycle unless one is already running (overlap guard). */
function tick(): void {
  if (isRunning) {
    logger.warn('cycle still running, skipping tick');
    return;
  }
  isRunning = true;
  currentCycle = runCycle().finally(() => {
    isRunning = false;
  });
}

/**
 * Start the polling worker: run one cycle immediately, then every
 * config.POLL_INTERVAL_SECONDS. Idempotent — calling twice is a no-op.
 */
export function startWorker(): void {
  if (intervalHandle) {
    logger.warn('startWorker called but worker is already running');
    return;
  }
  const intervalMs = config.POLL_INTERVAL_SECONDS * 1000;
  logger.info(
    { intervalSeconds: config.POLL_INTERVAL_SECONDS, connectionConcurrency: CONNECTION_CONCURRENCY },
    'polling worker started',
  );

  tick(); // run immediately, don't wait the first interval
  intervalHandle = setInterval(tick, intervalMs);
}

/**
 * Stop the worker: clear the interval and wait for any in-flight cycle to
 * finish so the DB pool can be closed cleanly afterwards.
 */
export async function stopWorker(): Promise<void> {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (currentCycle) {
    logger.info('waiting for in-flight ingestion cycle to finish');
    await currentCycle;
    currentCycle = null;
  }
  logger.info('polling worker stopped');
}
