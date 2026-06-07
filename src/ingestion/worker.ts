import { config } from '../config.js';
import { logger } from '../logger.js';
import { listActiveClients } from '../db/repositories/clients.js';
import { ingestExecutionsForClient } from './ingestExecutions.js';

/**
 * Max clients ingested concurrently per cycle. Separate from (and outer to) the
 * per-execution CONCURRENCY inside ingestExecutionsForClient — keeps one slow
 * client's n8n from blocking the others.
 */
export const CLIENT_CONCURRENCY = 5;

let intervalHandle: NodeJS.Timeout | null = null;
let isRunning = false;
let currentCycle: Promise<void> | null = null;
let cycleCount = 0;

/** One ingestion cycle across all active clients. Never throws (logs instead). */
async function runCycle(): Promise<void> {
  const cycle = ++cycleCount;
  const startedAt = Date.now();

  try {
    const clients = await listActiveClients();
    logger.info({ cycle, activeClients: clients.length }, 'ingestion cycle start');

    let clientsProcessed = 0;
    let totalNew = 0;
    let totalErrors = 0;

    for (let i = 0; i < clients.length; i += CLIENT_CONCURRENCY) {
      const chunk = clients.slice(i, i + CLIENT_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((client) => ingestExecutionsForClient(client)),
      );

      settled.forEach((outcome, idx) => {
        const client = chunk[idx];
        clientsProcessed += 1;
        if (outcome.status === 'fulfilled') {
          const r = outcome.value;
          totalNew += r.new;
          totalErrors += r.errors;
          logger.info(
            {
              cycle,
              client: client.name,
              clientId: client.id,
              fetched: r.fetched,
              new: r.new,
              errors: r.errors,
              newCursor: r.newCursor,
            },
            'client ingested',
          );
        } else {
          totalErrors += 1;
          logger.error(
            { cycle, client: client.name, clientId: client.id, err: outcome.reason },
            'client ingestion rejected',
          );
        }
      });
    }

    logger.info(
      {
        cycle,
        clientsProcessed,
        totalNew,
        totalErrors,
        durationMs: Date.now() - startedAt,
      },
      'ingestion cycle complete',
    );
  } catch (err) {
    // e.g. listActiveClients failed — never let a cycle crash the worker.
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
    { intervalSeconds: config.POLL_INTERVAL_SECONDS, clientConcurrency: CLIENT_CONCURRENCY },
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
