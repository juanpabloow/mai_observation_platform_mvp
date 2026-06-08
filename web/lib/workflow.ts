import { cache } from "react";
import { getWorkflowByN8nId } from "@worker/db/repositories/workflows.js";
import { getCurrentTenantId } from "./tenant";

/**
 * Resolve an n8n workflow id to its workflow row for the current tenant, always
 * tenant-scoped. Wrapped in React.cache so the workflow layout and the page
 * under it share a single query per request. Returns null when the workflow
 * doesn't exist or belongs to another tenant — callers should notFound().
 */
export const getWorkflowForCurrentTenant = cache(async (n8nWorkflowId: string) => {
  const tenantId = await getCurrentTenantId();
  return getWorkflowByN8nId({ tenantId, n8nWorkflowId });
});
