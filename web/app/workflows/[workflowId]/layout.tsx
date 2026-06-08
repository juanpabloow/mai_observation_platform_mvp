import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkflowForCurrentTenant } from "@/lib/workflow";
import { statusBadgeClasses } from "@/lib/format";
import { WorkflowTabs } from "@/components/WorkflowTabs";

/**
 * Shared layout for everything under a workflow. Resolves the workflow
 * (tenant-scoped) once — notFound() if missing — and renders the workflow
 * header + tab nav. Future sibling views (analytics, conversations) render as
 * children under the same header/tabs simply by adding their route folder.
 */
export default async function WorkflowLayout({
  params,
  children,
}: {
  params: Promise<{ workflowId: string }>;
  children: React.ReactNode;
}) {
  const { workflowId } = await params;
  const workflow = await getWorkflowForCurrentTenant(workflowId);
  if (!workflow) {
    notFound();
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-10">
      <div className="space-y-3">
        <Link
          href="/workflows"
          className="text-sm text-neutral-500 transition-colors hover:text-neutral-300"
        >
          &larr; Workflows
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
        <WorkflowTabs workflowId={workflow.n8n_workflow_id} />
      </div>

      {children}
    </main>
  );
}
