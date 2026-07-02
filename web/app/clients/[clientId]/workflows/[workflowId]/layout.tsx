import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveWorkflowUnderClient } from "@/lib/clientWorkflow";
import { statusBadgeClasses } from "@/lib/format";

/**
 * Shared layout for everything under a workflow
 * (/clients/[clientId]/workflows/[workflowId]). Resolves the workflow tenant-
 * scoped (deduped with the page via React.cache) — notFound() if it isn't this
 * tenant's — and renders the workflow header.
 *
 * SCROLL ARCHITECTURE (under the fixed shell): this layout fills the content
 * region and PINS the workflow heading (shrink-0), then hands its sub-page a slot
 * that fills the rest. The slot's behavior depends on the route (read from the
 * middleware's x-pathname — same source AppHeader uses):
 *   - executions → a BOUNDED slot (no scroll of its own) so the master-detail can
 *     give its table column + detail panel their OWN independent scroll regions.
 *   - every other sub-page (analytics, conversations list/thread/settings) → a
 *     SCROLLING slot with the familiar centered max-w-6xl padded column, so those
 *     pages scroll normally under the fixed shell with no per-page changes.
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

  const pathname = (await headers()).get("x-pathname") ?? "";
  // The executions master-detail owns its internal scroll; everything else scrolls
  // the slot. (x-pathname carries no query string, so a plain suffix test is safe.)
  const isExecutions = pathname.endsWith("/executions");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Pinned workflow heading — stays put while the sub-page content scrolls. */}
      <div className="shrink-0 border-b border-line px-6 py-5">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-3">
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
      </div>

      {isExecutions ? (
        // Bounded slot: the workspace fills it and scrolls its columns internally.
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      ) : (
        // Scrolling slot: full-width scrollbar, familiar centered content column.
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">{children}</div>
        </div>
      )}
    </div>
  );
}
