import { getSessionScope } from "@/lib/access";
import { buildEnabledModulesMap } from "@/lib/enabledModulesMap";
import { getClientById, getDefaultClientForTenant } from "@worker/db/repositories/clients.js";
import {
  listClientModules,
  listClientModulesForTenant,
} from "@worker/db/repositories/clientModules.js";
import { AppSidebar } from "./AppSidebar";

/**
 * Server wrapper that feeds the access scope into the (client) AppSidebar. The
 * sidebar is route-reactive (usePathname/useSearchParams) so it must stay a client
 * component, but the role/scope comes from the session at the data layer — never
 * the URL.
 *
 * We pass MINIMAL data:
 *  - memberClientId: when set (a member), the tenant-level rail shows their single
 *    client's surfaces instead of the Hub + Clients & Workflows management.
 *  - defaultClientId (owner/admin): identifies the "Unassigned" client by its real
 *    is_default row — the rail hides Modules for it.
 *  - enabledModules: clientId → ENABLED module keys. Owner/admin: the whole
 *    tenant in ONE query, with the DEFAULT client's rows EXCLUDED (backfill
 *    residue is inert — Unassigned never shows Contacts/Agenda). A member gets
 *    only their client's entry, and nothing at all if their client is somehow
 *    the default. After a toggle the panel's router.refresh() re-renders this
 *    server component, so a disabled module's link disappears.
 * The rail no longer renders workflow names (the header switcher + the Workflows
 * list own that), so NO workflow list is serialized here — in particular a member
 * never receives any workflow data through the sidebar.
 * Graceful (non-redirecting) like AppHeader — the page itself owns any redirect.
 */
export async function AppSidebarServer() {
  const scope = await getSessionScope();
  if (!scope) {
    return <AppSidebar memberClientId={null} defaultClientId={null} enabledModules={{}} />;
  }

  let defaultClientId: string | null = null;
  let enabledModules: Record<string, string[]> = {};

  if (scope.memberClientId) {
    // Member: their client's module rows only.
    const [memberClient, moduleRows] = await Promise.all([
      getClientById({ tenantId: scope.tenantId, clientId: scope.memberClientId }),
      listClientModules(scope.tenantId, scope.memberClientId),
    ]);
    // A default client never exposes modules (defensive: a member shouldn't be
    // scoped to the default, but fail closed if data says otherwise).
    if (memberClient && !memberClient.is_default) {
      enabledModules = buildEnabledModulesMap(moduleRows, null);
    }
  } else {
    const [defaultClient, moduleRows] = await Promise.all([
      getDefaultClientForTenant(scope.tenantId),
      listClientModulesForTenant(scope.tenantId), // one query, no N+1
    ]);
    defaultClientId = defaultClient?.id ?? null;
    // Default client's rows excluded — Unassigned never shows module links.
    enabledModules = buildEnabledModulesMap(moduleRows, defaultClientId);
  }

  return (
    <AppSidebar
      memberClientId={scope.memberClientId}
      defaultClientId={defaultClientId}
      enabledModules={enabledModules}
    />
  );
}
