import Link from "next/link";
import { connection } from "next/server";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import {
  listWorkflowsWithClientForTenant,
  type WorkflowWithClient,
} from "@worker/db/repositories/workflows.js";
import { countActiveConnectionsForTenant } from "@worker/db/repositories/stats.js";
import { getCurrentTenantId } from "@/lib/tenant";

/**
 * Interim Clients → Workflows navigation. The real folder UI is CL-2; this is a
 * bare-bones, tenant-scoped index so workflows can be reached under their client
 * at the new nested URLs. Clients are listed default-first; each workflow links
 * to /clients/[clientId]/workflows/[workflowId]/executions.
 */
export default async function ClientsPage() {
  await connection();

  const tenantId = await getCurrentTenantId();
  const [clients, workflows, activeConnections] = await Promise.all([
    listClientsForTenant(tenantId),
    listWorkflowsWithClientForTenant(tenantId),
    countActiveConnectionsForTenant(tenantId),
  ]);

  // Group workflows by their owning client (sorted by name within each client).
  const byClient = new Map<string, WorkflowWithClient[]>();
  for (const w of workflows) {
    const list = byClient.get(w.client_id);
    if (list) list.push(w);
    else byClient.set(w.client_id, [w]);
  }
  for (const list of byClient.values()) {
    list.sort((a, b) => (a.name ?? a.n8n_workflow_id).localeCompare(b.name ?? b.n8n_workflow_id));
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <header className="space-y-2">
        <Link
          href="/"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; Overview
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Clients</h1>
        <p className="text-sm text-neutral-500">
          {clients.length} client{clients.length === 1 ? "" : "s"} · pick a workflow to view
          its executions
        </p>
      </header>

      {activeConnections === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-black/15 px-5 py-8 dark:border-white/15">
          <p className="text-sm text-neutral-400">
            No n8n connection yet — connect one to start ingesting workflows and
            executions.
          </p>
          <Link
            href="/settings/connections"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Connect n8n
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {clients.map((client) => {
            const clientWorkflows = byClient.get(client.id) ?? [];
            return (
              <section key={client.id} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-lg font-semibold tracking-tight">{client.name}</h2>
                  {client.is_default ? (
                    <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
                      default
                    </span>
                  ) : null}
                  <span className="text-sm text-neutral-500">
                    {client.workflow_count} workflow{client.workflow_count === 1 ? "" : "s"}
                  </span>
                </div>

                {clientWorkflows.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-black/10 px-4 py-6 text-center text-sm text-neutral-600 dark:border-white/10">
                    No workflows in this client yet.
                  </p>
                ) : (
                  <ul className="overflow-hidden rounded-2xl border border-black/10 dark:border-white/10">
                    {clientWorkflows.map((w) => (
                      <li key={w.n8n_workflow_id}>
                        <Link
                          href={`/clients/${client.id}/workflows/${encodeURIComponent(w.n8n_workflow_id)}/executions`}
                          className="flex items-center justify-between gap-4 border-b border-black/5 px-4 py-3 transition-colors last:border-b-0 hover:bg-black/[0.03] dark:border-white/5 dark:hover:bg-white/[0.04]"
                        >
                          <span className="flex min-w-0 items-center gap-3">
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                w.active ? "bg-green-400" : "bg-neutral-600"
                              }`}
                              title={w.active ? "Active" : "Inactive"}
                            />
                            <span className="min-w-0">
                              <span className="block truncate font-medium">
                                {w.name ?? w.n8n_workflow_id}
                              </span>
                              <span className="block truncate font-mono text-xs text-neutral-500">
                                {w.n8n_workflow_id}
                              </span>
                            </span>
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </main>
  );
}
