import { notFound } from "next/navigation";
import { resolveWorkflowUnderClient } from "@/lib/clientWorkflow";

/**
 * Shared GUARD for everything under a workflow
 * (/clients/[clientId]/workflows/[workflowId]). Resolves the workflow tenant-
 * scoped (deduped with the page via React.cache) — notFound() if it isn't this
 * tenant's — then renders its child straight through.
 *
 * H-8.1: this layout no longer decides the content wrapper. Deciding it here meant
 * reading the request pathname (headers() x-pathname) and branching bounded-vs-
 * padded — but App Router renders a shared layout ONCE on section entry and REUSES
 * it across sibling client-side navigations (a layout is not re-rendered when only
 * the page below it changes). So the branch FROZE at whichever page you entered
 * through: enter on executions (bounded, no padding) then client-nav to Inbox and
 * Inbox inherited the bounded slot → flush-against-the-edges; enter on Inbox then
 * nav to executions and the master-detail got trapped in the padded column. The
 * wrapper now lives in two sibling route groups — (workspace) for the full-bleed
 * executions master-detail, (padded) for the centered column everything else uses.
 * Crossing those groups REMOUNTS the group layout, so each section always gets its
 * own wrapper and it can never go stale. Route groups don't change the URL.
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
