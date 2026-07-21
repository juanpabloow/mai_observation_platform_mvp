import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { resolveWorkflowUnderClient } from "@/lib/clientWorkflow";

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

  // H-8: the large workflow title block was removed from ALL workflow sections — the
  // breadcrumb (tenant / workflow) already carries identity, and each section renders
  // its own compact header. `workflow` is still resolved above for the RBAC/notFound
  // guard (and cached for the page).
  void workflow;

  const pathname = (await headers()).get("x-pathname") ?? "";
  // The executions master-detail owns its internal scroll; everything else scrolls
  // the slot. (x-pathname carries no query string, so a plain suffix test is safe.)
  const isExecutions = pathname.endsWith("/executions");

  return isExecutions ? (
    // Bounded slot: the workspace fills it and scrolls its columns internally.
    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
  ) : (
    // Scrolling slot: full-width scrollbar, familiar centered content column. This is
    // the ONE padded wrapper for every non-executions section (Inbox/Analytics/…), so
    // hard-load and client-nav always render with identical spacing.
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">{children}</div>
    </div>
  );
}
