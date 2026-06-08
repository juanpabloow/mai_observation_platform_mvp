import { firstRowOrThrow, query } from '../client.js';
import type { IngestionStateRow } from '../types.js';

/** Fetch the ingestion cursor/health for a connection, or null if none yet. */
export async function getIngestionState(
  connectionId: string,
): Promise<IngestionStateRow | null> {
  const result = await query<IngestionStateRow>(
    `SELECT * FROM ingestion_state WHERE n8n_connection_id = $1`,
    [connectionId],
  );
  return result.rows[0] ?? null;
}

/**
 * Record a successful poll: advance the cursor, stamp the poll times, and reset
 * the failure counter. Upserts the row if it does not exist yet.
 */
export async function recordSuccessfulPoll(
  connectionId: string,
  tenantId: string,
  lastSeenExecutionId: string | null,
): Promise<IngestionStateRow> {
  const result = await query<IngestionStateRow>(
    `INSERT INTO ingestion_state
       (n8n_connection_id, tenant_id, last_seen_execution_id, last_polled_at, last_successful_poll_at, consecutive_failures, last_error)
     VALUES ($1, $2, $3, now(), now(), 0, NULL)
     ON CONFLICT (n8n_connection_id) DO UPDATE SET
       last_seen_execution_id = EXCLUDED.last_seen_execution_id,
       last_polled_at = now(),
       last_successful_poll_at = now(),
       consecutive_failures = 0,
       last_error = NULL
     RETURNING *`,
    [connectionId, tenantId, lastSeenExecutionId],
  );
  return firstRowOrThrow(result, 'recordSuccessfulPoll');
}

/**
 * Record a failed poll: stamp the poll time, increment the failure counter, and
 * store the error message. Upserts the row if it does not exist yet.
 */
export async function recordFailedPoll(
  connectionId: string,
  tenantId: string,
  errorMessage: string,
): Promise<IngestionStateRow> {
  const result = await query<IngestionStateRow>(
    `INSERT INTO ingestion_state
       (n8n_connection_id, tenant_id, last_polled_at, consecutive_failures, last_error)
     VALUES ($1, $2, now(), 1, $3)
     ON CONFLICT (n8n_connection_id) DO UPDATE SET
       last_polled_at = now(),
       consecutive_failures = ingestion_state.consecutive_failures + 1,
       last_error = EXCLUDED.last_error
     RETURNING *`,
    [connectionId, tenantId, errorMessage],
  );
  return firstRowOrThrow(result, 'recordFailedPoll');
}
