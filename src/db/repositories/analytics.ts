import { query } from '../client.js';

/**
 * Inbox send outcomes over the last N local days (America/Bogota), optionally narrowed to one
 * workflow or one client. The technical analytics screens that used the rest of this module were
 * folded into COSTOS DE IA → Ejecuciones (src/db/repositories/n8nExecutionsUsage.ts, which
 * reads any date range); this summary stays for the Gallery incident checks. Read-only.
 */

const TZ = 'America/Bogota';

/** Scope: tenant + range, optionally narrowed to one workflow or one client. */
export interface AnalyticsScope {
  tenantId: string;
  days: number;
  n8nWorkflowId?: string | null;
  clientId?: string | null;
}

// Param order for the scoped queries: $1 tenant, $2 days, $3 tz, $4 workflow, $5 client.
const params = (s: AnalyticsScope) =>
  [s.tenantId, s.days, TZ, s.n8nWorkflowId ?? null, s.clientId ?? null] as const;

const WINDOW_START = `(date_trunc('day', now() AT TIME ZONE $3) - make_interval(days => $2::int - 1)) AT TIME ZONE $3`;

export interface HandoffSendSummary {
  total: number;
  accepted: number;
  failed: number;
  pending: number;
  failedByCode: { code: string; count: number }[];
}

export async function getHandoffSendSummary(s: AnalyticsScope): Promise<HandoffSendSummary> {
  const SCOPE = `hm.tenant_id = $1 AND hm.sender = 'human_agent'
        AND hm.occurred_at >= ${WINDOW_START}
        AND ($4::text IS NULL OR c.n8n_workflow_id = $4)
        AND ($5::uuid IS NULL OR EXISTS (
              SELECT 1 FROM workflows w
               WHERE w.tenant_id = c.tenant_id AND w.n8n_workflow_id = c.n8n_workflow_id AND w.client_id = $5))`;
  const totals = await query<{ total: number; accepted: number; failed: number; pending: number }>(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE hm.status = 'sent')::int AS accepted,
            count(*) FILTER (WHERE hm.status = 'failed')::int AS failed,
            count(*) FILTER (WHERE hm.status = 'sending')::int AS pending
       FROM handoff_messages hm
       JOIN conversations c ON c.id = hm.conversation_id AND c.tenant_id = hm.tenant_id
      WHERE ${SCOPE}`,
    [...params(s)],
  );
  const codes = await query<{ code: string; count: number }>(
    `SELECT COALESCE(hm.failure_code, 'UNKNOWN') AS code, count(*)::int AS count
       FROM handoff_messages hm
       JOIN conversations c ON c.id = hm.conversation_id AND c.tenant_id = hm.tenant_id
      WHERE ${SCOPE} AND hm.status = 'failed'
      GROUP BY 1
      ORDER BY 2 DESC, 1`,
    [...params(s)],
  );
  const t = totals.rows[0];
  return { total: t.total, accepted: t.accepted, failed: t.failed, pending: t.pending, failedByCode: codes.rows };
}
