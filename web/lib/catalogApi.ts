import "server-only";
import { authenticateHandoffRequest } from "@/lib/handoffApi";
import type { Capability } from "@worker/db/repositories/handoffTokens.js";
import { parseWorkflowRef } from "@worker/scheduling/workflowRef.js";
import { resolveWorkflowForConnection } from "@worker/db/repositories/workflows.js";
import { isClientModuleEnabled } from "@worker/db/repositories/clientModules.js";

/**
 * Shared auth + scope for the n8n-facing CATALOG API (app/api/catalog/v1/*).
 * MACHINE-only: Bearer token + an X-Workflow-Ref header — the SAME chain as the
 * scheduling and CRM APIs, so a token can only ever touch the ONE client its workflow
 * ref resolves to. tenant_id and client_id are NEVER accepted from the request. The
 * capability (catalog.read) is enforced in the chokepoint BEFORE scope, so a token
 * without it is refused with the identical 401 (indistinguishable from a bad token).
 * CHANNEL-BLIND: nothing here names a channel.
 *
 * Refusal bodies are byte-identical to the scheduling/CRM families where they overlap
 * (401 unauthorized, 404 not_found) so a probe learns nothing from comparing families.
 */

export interface CatalogAuth {
  tenantId: string;
  connectionId: string;
  tokenId: string;
  workflowRef: string;
  /** The workflow's owning client — the ONLY client this request may touch. */
  clientId: string;
}
export type CatalogAuthResult = { ok: true; auth: CatalogAuth } | { ok: false; response: Response };

/** The one machine error shape: { error: { code, message } }. */
export function catalogError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

/**
 * Authenticate + capability-check + resolve the catalog scope. Failure modes mirror the
 * CRM/scheduling APIs exactly (byte-identical bodies where they overlap):
 *  - no/invalid/revoked token, OR a token WITHOUT `capability` → the handoff 401.
 *  - X-Workflow-Ref missing/blank → 400 workflow_ref_required.
 *  - unknown/wrong-connection/wrong-tenant workflow → 404 not_found.
 *  - workflow on the default client, or the catalog module disabled → 403 module_disabled.
 */
export async function authenticateCatalog(req: Request, capability: Capability): Promise<CatalogAuthResult> {
  const result = await authenticateHandoffRequest(req, capability);
  if (!result.ok) return { ok: false, response: result.response };
  const { tenantId, connectionId, tokenId } = result.auth;

  const workflowRef = parseWorkflowRef(req.headers.get("x-workflow-ref"));
  if (!workflowRef) return { ok: false, response: catalogError(400, "workflow_ref_required", "X-Workflow-Ref header is required.") };

  const wf = await resolveWorkflowForConnection(tenantId, connectionId, workflowRef);
  if (!wf) return { ok: false, response: catalogError(404, "not_found", "Workflow not found.") };
  // Default client can't have modules; a non-default client must have catalog enabled. Both
  // surface as module_disabled (the workflow DOES belong to the token — not a 404).
  if (wf.client_is_default || !(await isClientModuleEnabled(tenantId, wf.client_id, "catalog"))) {
    return { ok: false, response: catalogError(403, "module_disabled", "Catalog module is disabled for this client.") };
  }
  return { ok: true, auth: { tenantId, connectionId, tokenId, workflowRef: wf.n8n_workflow_id, clientId: wf.client_id } };
}
