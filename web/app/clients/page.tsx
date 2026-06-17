import Link from "next/link";
import { connection } from "next/server";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { countActiveConnectionsForTenant } from "@worker/db/repositories/stats.js";
import { getCurrentTenantId } from "@/lib/tenant";
import {
  ClientsWorkflowsView,
  type ClientFolderView,
  type ClientOption,
  type WorkflowItem,
} from "@/components/ClientsWorkflowsView";

/**
 * Clients & Workflows — the folder view over the CL-1 client data layer. The
 * tenant's DEFAULT client is shown as loose "Unassigned" workflows; every other
 * client is an expandable folder. Data is loaded server-side (tenant-scoped);
 * the expand/collapse + ⋯ menus + create/rename/delete modals are client-side
 * (ClientsWorkflowsView). All mutations go through clientActions → the clients repo.
 */
export default async function ClientsPage() {
  await connection();

  const tenantId = await getCurrentTenantId();
  const [clients, workflows, activeConnections] = await Promise.all([
    listClientsForTenant(tenantId),
    listWorkflowsWithClientForTenant(tenantId),
    countActiveConnectionsForTenant(tenantId),
  ]);

  // Soft-gate: no connection → nothing has synced yet, so prompt to connect
  // rather than show an empty folder view.
  if (activeConnections === 0) {
    return (
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-6 py-20">
        <header className="space-y-2">
          <Link href="/" className="text-sm text-neutral-500 transition-colors hover:text-neutral-300">
            &larr; Overview
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Clients &amp; Workflows</h1>
        </header>
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-black/15 px-5 py-8 dark:border-white/15">
          <p className="text-sm text-neutral-400">
            No n8n connection yet — connect one to start ingesting workflows.
          </p>
          <Link
            href="/settings/connections"
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-emerald-500"
          >
            Connect n8n
          </Link>
        </div>
      </main>
    );
  }

  const byName = (a: WorkflowItem, b: WorkflowItem) =>
    (a.name ?? a.n8nWorkflowId).localeCompare(b.name ?? b.n8nWorkflowId);

  // Group workflows by their owning client.
  const byClient = new Map<string, WorkflowItem[]>();
  for (const w of workflows) {
    const item: WorkflowItem = {
      id: w.id,
      n8nWorkflowId: w.n8n_workflow_id,
      name: w.name,
      active: w.active,
      clientId: w.client_id,
    };
    const list = byClient.get(w.client_id);
    if (list) list.push(item);
    else byClient.set(w.client_id, [item]);
  }

  const defaultClient = clients.find((c) => c.is_default);
  const looseWorkflows = (byClient.get(defaultClient?.id ?? "") ?? []).sort(byName);

  const folders: ClientFolderView[] = clients
    .filter((c) => !c.is_default)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({
      id: c.id,
      name: c.name,
      workflowCount: c.workflow_count,
      workflows: (byClient.get(c.id) ?? []).sort(byName),
    }));

  // Picker options for "Move to" (default first, labeled "Unassigned" in the UI).
  const clientOptions: ClientOption[] = [
    ...(defaultClient ? [{ id: defaultClient.id, name: defaultClient.name, isDefault: true }] : []),
    ...clients
      .filter((c) => !c.is_default)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((c) => ({ id: c.id, name: c.name, isDefault: false })),
  ];

  return (
    <ClientsWorkflowsView
      looseWorkflows={looseWorkflows}
      folders={folders}
      clientOptions={clientOptions}
    />
  );
}
