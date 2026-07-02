import { redirect } from "next/navigation";
import { getExecutionByIdForTenant } from "@worker/db/repositories/executions.js";
import { getAccessScope } from "@/lib/access";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";

/**
 * Legacy compatibility redirect. The full-page execution detail is GONE — an
 * execution now opens as a resizable side PANEL on its workflow's executions page
 * (?execution=<id>), which keeps the client/workflow breadcrumb + sidebar stable.
 * This stub just forwards any old /executions/[id] bookmark to that panel URL.
 *
 * Access-scoped, no leak: getWorkflowForCurrentTenant resolves the workflow within
 * the caller's RBAC scope (a member gets null for a workflow outside their client,
 * an owner/admin any of their tenant's) — an unreachable/foreign/absent execution
 * lands on /clients rather than disclosing anything.
 */
export default async function LegacyExecutionRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await getAccessScope();

  const execution = await getExecutionByIdForTenant({ tenantId: scope.tenantId, id });
  if (!execution) redirect("/clients");

  const workflow = await getWorkflowForCurrentTenant(execution.n8n_workflow_id);
  if (!workflow?.client_id) redirect("/clients");

  redirect(
    `/clients/${workflow.client_id}/workflows/${encodeURIComponent(
      execution.n8n_workflow_id,
    )}/executions?execution=${encodeURIComponent(id)}`,
  );
}
