import { decrypt } from '../crypto.js';
import { logger } from '../logger.js';
import { createN8nClient } from '../n8n/client.js';
import { upsertWorkflows, type WorkflowUpsert } from '../db/repositories/workflows.js';
import type { N8nConnectionRow } from '../db/types.js';

/** Page size when listing workflows. */
const PAGE_LIMIT = 100;

export interface SyncResult {
  /** Number of workflow rows upserted (inserted or updated) this run. */
  synced: number;
  /** Whether the sync completed without error. */
  ok: boolean;
}

/**
 * Sync the `workflows` table for one connection from n8n's GET /workflows.
 * Upserts on (connection, n8n_workflow_id), refreshing name/active/last_synced_at
 * and leaving client_id assignments untouched. Never throws — a sync failure is
 * logged and reported so it doesn't block execution ingestion.
 */
export async function syncWorkflowsForConnection(
  connection: N8nConnectionRow,
): Promise<SyncResult> {
  const tenantId = connection.tenant_id;
  const connectionId = connection.id;

  try {
    const apiKey = decrypt(connection.n8n_api_key_encrypted);
    const n8n = createN8nClient({ baseUrl: connection.n8n_base_url, apiKey });

    // Page through all workflows.
    const toUpsert: WorkflowUpsert[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await n8n.listWorkflows({ limit: PAGE_LIMIT, cursor });
      for (const wf of page.data) {
        toUpsert.push({
          tenant_id: tenantId,
          n8n_connection_id: connectionId,
          n8n_workflow_id: wf.id,
          name: wf.name,
          active: wf.active,
        });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    const synced = await upsertWorkflows(toUpsert);
    logger.info(
      { connection: connection.name, connectionId, tenantId, synced },
      'workflow sync complete',
    );
    return { synced, ok: true };
  } catch (err) {
    logger.error(
      { err, connection: connection.name, connectionId },
      'workflow sync failed; continuing',
    );
    return { synced: 0, ok: false };
  }
}
