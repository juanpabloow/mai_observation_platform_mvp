import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
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
 * Run `fn` inside a single transaction on a dedicated pooled client: BEGIN, then
 * COMMIT on success or ROLLBACK on any throw (re-raising the original error). The
 * client is always released. Used by the booking engine, where the availability
 * revalidation + insert + event log must be atomic and the insert relies on the
 * appointments GiST exclusion constraint for the anti-double-book guarantee.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // A failed rollback (e.g. a dead connection) must not mask the real error.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** True iff `err` is a Postgres exclusion-constraint violation (SQLSTATE 23P01) —
 * i.e. the anti-double-book guard fired. Callers map this to HTTP 409. */
export function isExclusionViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23P01';
}

/** True iff `err` is a Postgres unique-violation (SQLSTATE 23505). Used to detect
 * an idempotency-key collision race. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** True iff `err` is a Postgres deadlock (SQLSTATE 40P01). The per-staff advisory
 * lock should prevent booking deadlocks, but this is mapped to a slot conflict as
 * defense-in-depth so a rare deadlock never surfaces as a 500. */
export function isDeadlock(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '40P01';
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
