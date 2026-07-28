import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { getAccessScope, hasFullAccess } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { resolveWorkflowScope } from "@/lib/workflowScope";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { ClientWorkflowsList, type ClientWorkflowRow } from "@/components/ClientWorkflowsList";

/**
 * The workflow SETTINGS picker at /clients/[clientId]/workflows/all/settings — the
 * "all-workflows" landing of the sidebar's owner/admin-only "Settings" entry (restoring
 * the per-workflow Handoff & mapping settings entry point that W-2 orphaned). Same list
 * component + behavior as the Executions picker (/clients/[c]/workflows); only the rows
 * lead to each workflow's settings page and the copy differs.
 *
 * Owner/admin ONLY: the settings page carries the Human Handoff webhook config (secret,
 * enable/delete). A member is refused server-side here (indistinguishable 404), matching
 * the settings section's data-layer gating. Access is resolved from the SESSION, never
 * the URL; only THIS client's workflows are ever serialized.
 */
export default async function WorkflowSettingsPickerPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;

  const scope = await getAccessScope();
  if (!hasFullAccess(scope)) notFound(); // owner/admin only — never disclosed to members
  const client = await getClientForTenant(clientId);
  if (!client) notFound(); // foreign / bogus client → 404

  // Mirror the Executions picker: if a specific workflow is the remembered scope, jump
  // straight to its settings; 'all' (or a stale/foreign scope, which resolveWorkflowScope
  // collapses to 'all') renders the list.
  const resolved = await resolveWorkflowScope(scope.tenantId, client.id, scope);
  if (resolved !== "all") {
    redirect(`/clients/${client.id}/workflows/${encodeURIComponent(resolved)}/conversations/settings`);
  }

  const wfRows = await listWorkflowsWithClientForTenant(scope.tenantId);
  const workflows: ClientWorkflowRow[] = wfRows
    .filter((w) => w.client_id === client.id)
    .map((w) => ({ n8nWorkflowId: w.n8n_workflow_id, name: w.name, active: w.active }))
    .sort((a, b) => (a.name ?? a.n8nWorkflowId).localeCompare(b.name ?? b.n8nWorkflowId));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-0.5 text-sm text-muted">
          Pick a workflow to configure its handoff webhook &amp; field mappings, or use the header switcher.
        </p>
      </header>
      <ClientWorkflowsList clientId={client.id} workflows={workflows} section="settings" />
    </main>
  );
}
