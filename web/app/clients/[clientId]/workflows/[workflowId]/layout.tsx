import Link from "next/link";
import { notFound } from "next/navigation";
import { resolveWorkflowUnderClient } from "@/lib/clientWorkflow";
import { statusBadgeClasses } from "@/lib/format";
import { WorkflowTabs } from "@/components/WorkflowTabs";

/**
 * Shared layout for everything under a workflow, now nested as
 * /clients/[clientId]/workflows/[workflowId]. Resolves the workflow + its client
 * (tenant-scoped, deduped with the page via React.cache) — notFound() if the
 * workflow isn't this tenant's. Link-building uses the workflow's REAL client_id
 * (canonical), never the URL's clientId; a mismatch is redirected by the page.
 */
export default async function WorkflowLayout({
  params,
  children,
}: {
  params: Promise<{ clientId: string; workflowId: string }>;
  children: React.ReactNode;
}) {
  const { clientId, workflowId } = await params;
  const res = await resolveWorkflowUnderClient(clientId, workflowId);
  if (res.kind === "not_found") {
    notFound();
  }
  const { workflow, client } = res;
  // Canonical client for all hrefs (on a mismatch the page redirects, so this
  // layout's output is discarded — but the canonical id keeps links correct).
  const canonicalClientId = workflow.client_id ?? client.id;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="space-y-3">
        <Link
          href="/clients"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; {client.name}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {workflow.name ?? workflow.n8n_workflow_id}
          </h1>
          {workflow.active !== null ? (
            <span className={statusBadgeClasses(workflow.active ? "success" : "neutral")}>
              {workflow.active ? "active" : "inactive"}
            </span>
          ) : null}
          <span className="font-mono text-xs text-neutral-500">
            {workflow.n8n_workflow_id}
          </span>
        </div>
        <WorkflowTabs clientId={canonicalClientId} workflowId={workflow.n8n_workflow_id} />
      </div>

      {children}
    </main>
  );
}
