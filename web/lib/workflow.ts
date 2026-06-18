import { cache } from "react";
import { getWorkflowByN8nId } from "@worker/db/repositories/workflows.js";
import { getAccessScope, hasFullAccess, canAccessClient } from "./access";

/**
 * The current user's workflow by n8n id — tenant-scoped AND access-scoped. A
 * member sees only workflows of THEIR client; any other client's workflow (or an
 * orphan with no client) resolves to null, so every caller denies by default:
 * the execution-detail page (no foreign-execution leak) and the column /
 * conversation config actions (a member can configure only their own client's
 * workflows). Wrapped in React.cache so the layout + page share one query.
 */
export const getWorkflowForCurrentTenant = cache(async (n8nWorkflowId: string) => {
  const scope = await getAccessScope();
  const workflow = await getWorkflowByN8nId({ tenantId: scope.tenantId, n8nWorkflowId });
  if (!workflow) return null;
  const ownerClientId = workflow.client_id;
  // Orphan with no client (pre-CL-1a defensive): only full-access users may see it.
  if (!ownerClientId) return hasFullAccess(scope) ? workflow : null;
  if (!canAccessClient(scope, ownerClientId)) return null;
  return workflow;
});
