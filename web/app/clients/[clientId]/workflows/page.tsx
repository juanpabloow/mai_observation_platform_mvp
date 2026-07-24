import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getAccessScope } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { ClientWorkflowsList, type ClientWorkflowRow } from "@/components/ClientWorkflowsList";

/**
 * The client's WORKFLOWS list (final design) at /clients/[clientId]/workflows — the
 * target of the sidebar's "Workflows" entry. Lists the workflows ASSIGNED to this
 * client with name, active/inactive status, and the workflow id; each row opens that
 * workflow's Executions. Search + the empty state live in the client component.
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

  const wfRows = await listWorkflowsWithClientForTenant(scope.tenantId);
  const workflows: ClientWorkflowRow[] = wfRows
    .filter((w) => w.client_id === client.id)
    .map((w) => ({ n8nWorkflowId: w.n8n_workflow_id, name: w.name, active: w.active }))
    .sort((a, b) => (a.name ?? a.n8nWorkflowId).localeCompare(b.name ?? b.n8nWorkflowId));

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-6 py-8">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Workflows</h1>
        <p className="mt-0.5 text-sm text-muted">
          The workflows assigned to this client. Open one to see its executions and analytics.
        </p>
      </header>
      <ClientWorkflowsList clientId={client.id} workflows={workflows} />
    </main>
  );
}
