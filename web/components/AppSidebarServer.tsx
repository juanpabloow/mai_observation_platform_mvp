import { getSessionScope } from "@/lib/access";
import { getServerSession } from "@/lib/session";
import { buildEnabledModulesMap } from "@/lib/enabledModulesMap";
import { getClientById, getDefaultClientForTenant } from "@worker/db/repositories/clients.js";
import {
  listClientModules,
  listClientModulesForTenant,
} from "@worker/db/repositories/clientModules.js";
import { AppSidebar } from "./AppSidebar";

/**
 * Server wrapper that feeds the access scope into the (client) AppSidebar. The
 * sidebar is route-reactive (usePathname) so it must stay a client component, but
 * the role/scope + account identity come from the session at the data layer — never
 * the URL.
 *
 * We pass MINIMAL data:
 *  - memberClientId: when set (a member), the tenant-level rail shows their single
 *    client's surfaces instead of the Hub + Clients & Workflows management.
 *  - defaultClientId (owner/admin): identifies the "Unassigned" client by its real
 *    is_default row — the rail hides Modules for it.
 *  - enabledModules: clientId → ENABLED module keys. Owner/admin: the whole tenant in
 *    ONE query, with the DEFAULT client's rows EXCLUDED (Unassigned never shows
 *    Contacts/Agenda). A member gets only their client's entry.
 *  - email / role / clientLabel: identity for the fixed account footer (the SAME
 *    account menu the header uses — one shared implementation).
 * The rail never renders workflow names (the header switcher + the Workflows list own
 * that), so NO workflow list is serialized here — a member never receives any
 * workflow data through the sidebar.
 * Graceful (non-redirecting) like AppHeader — the page itself owns any redirect;
 * logged-out → no rail.
 */
export async function AppSidebarServer() {
  const scope = await getSessionScope();
  if (!scope) return null;
  const session = await getServerSession();
  const email = session?.user?.email ?? "";
  const name = session?.user?.name ?? null;

  let defaultClientId: string | null = null;
  let enabledModules: Record<string, string[]> = {};
  let clientLabel: string | null = null;

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
    // Their client name — so the footer/menu shows where they're scoped.
    clientLabel = memberClient ? (memberClient.is_default ? "Unassigned" : memberClient.name) : null;
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
      name={name}
      memberClientId={scope.memberClientId}
      defaultClientId={defaultClientId}
      enabledModules={enabledModules}
      email={email}
      role={scope.role}
      clientLabel={clientLabel}
    />
  );
}
