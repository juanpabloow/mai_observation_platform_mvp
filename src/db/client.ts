import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Single, shared connection pool for the whole process.
 * Configured from the validated DATABASE_URL.
 */
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

// Surface errors from idle clients (e.g. the DB dropping a connection) instead
// of letting them crash the process silently.
pool.on('error', (err) => {
  logger.error({ err }, 'unexpected error on idle postgres client');
});

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

/** Gracefully drain and close the pool (call on shutdown). */
export async function closePool(): Promise<void> {
  await pool.end();
  logger.info('postgres pool closed');
}
