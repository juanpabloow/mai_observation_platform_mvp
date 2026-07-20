import { getSessionScope } from "@/lib/access";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { AppSidebar, type SidebarWorkflow } from "./AppSidebar";

/**
 * Server wrapper that feeds the access scope into the (client) AppSidebar. The
 * sidebar is route-reactive (usePathname/useSearchParams) so it must stay a client
 * component, but the role/scope comes from the session at the data layer — never
 * the URL.
 *
 * We pass:
 *  - memberClientId: when set (a member), the tenant-level rail shows their single
 *    client's overview instead of the Hub + Clients & Workflows management.
 *  - workflows (id + owning client): so the in-client rail can keep the workflow
 *    tabs (Executions/Conversations/Analytics) pointing at a real workflow even on
 *    the client-level Team page — resolving a remembered/first workflow CLIENT-side
 *    (same idea as CL-5c). It's the FULL tenant list (owner/admin), so any client's
 *    first workflow is computable without re-querying per navigation (the list is
 *    navigation-independent; router.refresh() after mutations keeps it current).
 *    Members don't see Team and their tabs come straight from the route, so the
 *    query is skipped for them.
 * Graceful (non-redirecting) like AppHeader — the page itself owns any redirect.
 */
export async function AppSidebarServer() {
  const scope = await getSessionScope();
  if (!scope) return <AppSidebar memberClientId={null} workflows={[]} />;

  // Workflows (owner/admin only) so the in-client rail can keep the workflow tabs
  // pointed at a real workflow even on the Team page. The per-workflow Inbox pending
  // badge (H-7) is polled client-side by InboxTabLink, so no counts are seeded here.
  const workflows: SidebarWorkflow[] = scope.memberClientId
    ? []
    : (await listWorkflowsWithClientForTenant(scope.tenantId)).map((w) => ({
        id: w.n8n_workflow_id,
        clientId: w.client_id,
        name: w.name,
      }));

  return <AppSidebar memberClientId={scope.memberClientId} workflows={workflows} />;
}
