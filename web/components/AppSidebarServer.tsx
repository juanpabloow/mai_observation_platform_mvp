import { getSessionScope } from "@/lib/access";
import { buildEnabledModulesMap } from "@/lib/enabledModulesMap";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { getClientById, getDefaultClientForTenant } from "@worker/db/repositories/clients.js";
import {
  listClientModules,
  listClientModulesForTenant,
} from "@worker/db/repositories/clientModules.js";
import { AppSidebar, type SidebarWorkflow } from "./AppSidebar";

/**
 * Server wrapper that feeds the access scope into the (client) AppSidebar. The
 * sidebar is route-reactive (usePathname/useSearchParams) so it must stay a client
 * component, but the role/scope comes from the session at the data layer — never
 * the URL.
 *
 * We pass MINIMAL data:
 *  - memberClientId: when set (a member), the tenant-level rail shows their single
 *    client's surfaces instead of the Hub + Clients & Workflows management.
 *  - workflows (id + owning client): so the in-client rail can keep the workflow
 *    tabs pointing at a real workflow even on client-level pages (Team/Modules/
 *    Contacts/Agenda). For a MEMBER the tenant list is filtered SERVER-SIDE to
 *    their one client before serializing — no other client's workflow ids/names
 *    ever reach their browser — so ?from validation and the workflow tabs keep
 *    working on their client-level routes.
 *  - defaultClientId (owner/admin): identifies the "Unassigned" client by its real
 *    is_default row — the rail hides Modules for it.
 *  - enabledModules: clientId → ENABLED module keys. Owner/admin: the whole
 *    tenant in ONE query, with the DEFAULT client's rows EXCLUDED (backfill
 *    residue is inert — Unassigned never shows Contacts/Agenda). A member gets
 *    only their client's entry, and nothing at all if their client is somehow
 *    the default. After a toggle the panel's router.refresh() re-renders this
 *    server component, so a disabled module's link disappears.
 * Graceful (non-redirecting) like AppHeader — the page itself owns any redirect.
 */
export async function AppSidebarServer() {
  const scope = await getSessionScope();
  if (!scope) {
    return (
      <AppSidebar memberClientId={null} workflows={[]} defaultClientId={null} enabledModules={{}} />
    );
  }

  let workflows: SidebarWorkflow[] = [];
  let defaultClientId: string | null = null;
  let enabledModules: Record<string, string[]> = {};

  if (scope.memberClientId) {
    // Member: their client's module rows + THEIR client's workflows only.
    const [memberClient, moduleRows, wfRows] = await Promise.all([
      getClientById({ tenantId: scope.tenantId, clientId: scope.memberClientId }),
      listClientModules(scope.tenantId, scope.memberClientId),
      listWorkflowsWithClientForTenant(scope.tenantId),
    ]);
    // A default client never exposes modules (defensive: a member shouldn't be
    // scoped to the default, but fail closed if data says otherwise).
    if (memberClient && !memberClient.is_default) {
      enabledModules = buildEnabledModulesMap(moduleRows, null);
    }
    // SERVER-SIDE filter: only the member's own client's workflows are serialized.
    workflows = wfRows
      .filter((w) => w.client_id === scope.memberClientId)
      .map((w) => ({ id: w.n8n_workflow_id, clientId: w.client_id, name: w.name }));
  } else {
    const [wfRows, defaultClient, moduleRows] = await Promise.all([
      listWorkflowsWithClientForTenant(scope.tenantId),
      getDefaultClientForTenant(scope.tenantId),
      listClientModulesForTenant(scope.tenantId), // one query, no N+1
    ]);
    workflows = wfRows.map((w) => ({ id: w.n8n_workflow_id, clientId: w.client_id, name: w.name }));
    defaultClientId = defaultClient?.id ?? null;
    // Default client's rows excluded — Unassigned never shows module links.
    enabledModules = buildEnabledModulesMap(moduleRows, defaultClientId);
  }

  return (
    <AppSidebar
      memberClientId={scope.memberClientId}
      workflows={workflows}
      defaultClientId={defaultClientId}
      enabledModules={enabledModules}
    />
  );
}
