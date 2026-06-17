import { notFound } from "next/navigation";
import { resolveWorkflowUnderClient } from "@/lib/clientWorkflow";
import { statusBadgeClasses } from "@/lib/format";

/**
 * Shared layout for everything under a workflow
 * (/clients/[clientId]/workflows/[workflowId]). Resolves the workflow tenant-
 * scoped (deduped with the page via React.cache) — notFound() if it isn't this
 * tenant's — and renders the workflow header. Navigation (back to the client,
 * switching workflows, and the feature tabs) is handled by the header breadcrumb
 * + the left sidebar (CL-4b), so this layout no longer renders a back link or
 * its own tab nav.
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
  const { workflow } = res;

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {workflow.name ?? workflow.n8n_workflow_id}
        </h1>
        {workflow.active !== null ? (
          <span className={statusBadgeClasses(workflow.active ? "success" : "neutral")}>
            {workflow.active ? "active" : "inactive"}
          </span>
        ) : null}
        <span className="font-mono text-xs text-faint">{workflow.n8n_workflow_id}</span>
      </div>

      {children}
    </main>
  );
}
