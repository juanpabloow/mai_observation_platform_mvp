import { notFound } from "next/navigation";
import { resolveWorkflowUnderClient } from "@/lib/clientWorkflow";

/**
 * Shared GUARD for everything under a workflow
 * (/clients/[clientId]/workflows/[workflowId]). Resolves the workflow tenant-
 * scoped (deduped with the page via React.cache) — notFound() if it isn't this
 * tenant's — then renders its child straight through.
 *
 * H-8.1: this layout must NOT decide the content wrapper (reading the pathname here
 * and branching went stale across client-side navigation). The (workspace)/(padded)
 * route groups own the slot; this stays a guard-only pass-through.
 *
 * W-1: the in-content Executions | Analytics tab bar was removed — those sections are
 * reached from the sidebar (Executions / Analytics), scoped to the current workflow by
 * the header switcher. So this layout returns its child unchanged.
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
  return children;
}
