import { getSessionScope } from "@/lib/access";
import { AppSidebar } from "./AppSidebar";

/**
 * Server wrapper that feeds the access scope into the (client) AppSidebar. The
 * sidebar is route-reactive (usePathname) so it must stay a client component, but
 * the role/scope comes from the session at the data layer — never the URL. We
 * pass only memberClientId: when set (a member), the tenant-level rail shows their
 * single client's overview instead of the Hub + Clients & Workflows management.
 * Graceful (non-redirecting) like AppHeader — the page itself owns any redirect.
 */
export async function AppSidebarServer() {
  const scope = await getSessionScope();
  return <AppSidebar memberClientId={scope?.memberClientId ?? null} />;
}
