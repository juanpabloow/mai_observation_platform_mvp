import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Single, shared connection pool for the whole process, configured from the
 * validated DATABASE_URL.
 *
 * Wrapped in a globalThis singleton guard so the pool is created EXACTLY ONCE.
 * For the worker (a single long-lived process) this is identical to before — the
 * module evaluates once, so the pool is created once. The guard only matters
 * when this module is RE-EVALUATED by the Next.js dev server's HMR (the web app
 * imports this shared data layer): there it reuses the existing pool instead of
 * leaking a fresh set of Postgres connections on every recompile.
 */
const globalForPool = globalThis as unknown as { __obsWorkerPool?: Pool };

function createPool(): Pool {
  const created = new Pool({
    connectionString: config.DATABASE_URL,
    application_name: 'obs-worker',
  });
  // Surface errors from idle clients (e.g. the DB dropping a connection) instead
  // of letting them crash the process silently. Attached once, on creation, so a
  // re-evaluated module reusing the pool never stacks duplicate listeners.
  created.on('error', (err) => {
    logger.error({ err }, 'unexpected error on idle postgres client');
  });
  return created;
}

export const pool: Pool =
  globalForPool.__obsWorkerPool ?? (globalForPool.__obsWorkerPool = createPool());

/**
 * Run a parameterized query against the pool. Always pass values via `params`
 * ($1, $2, ...) — never interpolate them into `text`.
 */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

/**
 * Helper for statements that must return exactly one row (e.g. INSERT ...
 * RETURNING). Throws a clear error rather than yielding `undefined`.
 */
export function firstRowOrThrow<T extends QueryResultRow>(
  result: QueryResult<T>,
  context: string,
): T {
  const row = result.rows[0];
  if (!row) {
    throw new Error(`${context}: expected a row to be returned, but none was`);
  }
  return row;
}

/**
 * Gracefully drain and close the pool (call on shutdown). Also clears the cached
 * singleton so a fresh pool would be created on a later re-evaluation (e.g. a
 * dev-HMR reload after a close) — never reusing an already-ended pool.
 */
export async function closePool(): Promise<void> {
  await pool.end();
  globalForPool.__obsWorkerPool = undefined;
  logger.info('postgres pool closed');
}
