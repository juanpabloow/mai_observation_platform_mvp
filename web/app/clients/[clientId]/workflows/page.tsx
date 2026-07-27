import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { getAccessScope } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { resolveWorkflowScope } from "@/lib/workflowScope";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { ClientWorkflowsList, type ClientWorkflowRow } from "@/components/ClientWorkflowsList";

/**
 * The client's workflow list at /clients/[clientId]/workflows — the "all-workflows"
 * landing of the sidebar's "Executions" entry (W-1). Lists the workflows ASSIGNED to
 * this client with name, active/inactive status, and the workflow id; each row opens
 * that workflow's Executions. When a specific workflow is the remembered scope, this
 * route redirects to it instead (see below). Search + the empty state live in the
 * client component.
 *
 * Access is resolved from the SESSION, never the URL: getClientForTenant validates
 * the clientId is a real client of THIS tenant AND accessible to the user (owner/
 * admin → any of their clients; member → only their one client) — any other client
 * is an indistinguishable 404. Only THIS client's workflows are ever serialized, so a
 * member never receives another client's workflow ids/names.
 */
export default async function ClientWorkflowsPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;

  const scope = await getAccessScope();
  const client = await getClientForTenant(clientId);
  if (!client) notFound(); // foreign / bogus / outside a member's scope → 404

  // W-1: this route is the "Executions" entry. If the client's remembered scope is a
  // still-valid workflow, jump to its executions; 'all' — or a stale/foreign scope,
  // which resolveWorkflowScope collapses to 'all' — renders the workflow list. The
  // resolver never throws and never returns an invalid workflow, so no redirect loop.
  const resolved = await resolveWorkflowScope(scope.tenantId, client.id, scope);
  if (resolved !== "all") {
    redirect(`/clients/${client.id}/workflows/${encodeURIComponent(resolved)}/executions`);
  }

  const wfRows = await listWorkflowsWithClientForTenant(scope.tenantId);
  const workflows: ClientWorkflowRow[] = wfRows
    .filter((w) => w.client_id === client.id)
    .map((w) => ({ n8nWorkflowId: w.n8n_workflow_id, name: w.name, active: w.active }))
    .sort((a, b) => (a.name ?? a.n8nWorkflowId).localeCompare(b.name ?? b.n8nWorkflowId));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Executions</h1>
        <p className="mt-0.5 text-sm text-muted">
          Pick a workflow to see its executions and analytics, or use the header switcher.
        </p>
      </header>
      <ClientWorkflowsList clientId={client.id} workflows={workflows} />
    </main>
  );
}
