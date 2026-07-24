import { resolveWorkflowForConnection } from '../db/repositories/workflows.js';
import { isSchedulingBookable } from '../db/repositories/clientModules.js';

/**
 * THE machine-API scheduling scope resolver — pure worker code (no server-only,
 * no Response), so it can be unit/integration-tested with PostgreSQL WITHOUT
 * importing Next route handlers. It encodes the security chain that every
 * /api/scheduling/v1/* call must pass AFTER Bearer auth:
 *
 *   (tenantId, connectionId, workflowRef)
 *     → the workflow synced under THAT connection (never tenant + ref alone)
 *     → its owning client_id
 *     → the client is NOT the default ("Unassigned")
 *     → that client's `scheduling` module is enabled
 *
 * A token can therefore never reach a workflow of another connection/tenant, nor
 * a client whose scheduling is off. The result is discriminated so the HTTP layer
 * maps it: workflow_not_found → 404, module_disabled → 403.
 */

export type MachineSchedulingScope =
  | { ok: true; clientId: string; workflowRef: string; workflowId: string }
  | { ok: false; reason: 'workflow_not_found' | 'module_disabled' };

export async function resolveMachineSchedulingScope(params: {
  tenantId: string;
  connectionId: string;
  workflowRef: string;
}): Promise<MachineSchedulingScope> {
  const wf = await resolveWorkflowForConnection(params.tenantId, params.connectionId, params.workflowRef);
  if (!wf) return { ok: false, reason: 'workflow_not_found' };
  // A workflow assigned to the default client, or whose client has scheduling
  // absent/disabled, both surface as module_disabled (403) — never as a
  // workflow_not_found, since the workflow DOES belong to the token.
  if (wf.client_is_default) return { ok: false, reason: 'module_disabled' };
  const enabled = await isSchedulingBookable(params.tenantId, wf.client_id);
  if (!enabled) return { ok: false, reason: 'module_disabled' };
  return { ok: true, clientId: wf.client_id, workflowRef: wf.n8n_workflow_id, workflowId: wf.id };
}
