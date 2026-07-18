import { getSessionScope } from "@/lib/access";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import {
  countPendingForClient,
  pendingCountsByClientForTenant,
} from "@worker/db/repositories/handoff.js";
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
  if (!scope) return <AppSidebar memberClientId={null} workflows={[]} pendingCounts={{}} />;

  // Workflows (owner/admin only) + per-client pending counts to SEED the Inbox tab
  // badges instantly (they then poll to stay live). A member only needs their own
  // client's count; owner/admin get every client's in one grouped query.
  const [workflows, pendingCounts] = await Promise.all([
    scope.memberClientId
      ? Promise.resolve<SidebarWorkflow[]>([])
      : listWorkflowsWithClientForTenant(scope.tenantId).then((rows) =>
          rows.map((w) => ({ id: w.n8n_workflow_id, clientId: w.client_id, name: w.name })),
        ),
    scope.memberClientId
      ? countPendingForClient(scope.tenantId, scope.memberClientId).then((count) => ({
          [scope.memberClientId as string]: count,
        }))
      : pendingCountsByClientForTenant(scope.tenantId).then((rows) =>
          Object.fromEntries(rows.map((r) => [r.client_id, r.count])),
        ),
  ]);

  return (
    <AppSidebar
      memberClientId={scope.memberClientId}
      workflows={workflows}
      pendingCounts={pendingCounts}
    />
  );
}
