import { headers } from "next/headers";
import { getServerSession } from "@/lib/session";
import { getTenantIdForUser } from "@worker/db/repositories/tenantMembers.js";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { HeaderBar, type HeaderClient, type HeaderWorkflow } from "./HeaderBar";

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/**
 * Global app header (logo / breadcrumb / profile). SERVER component in the root
 * layout: it gates visibility (no header on the auth screens or when logged out)
 * and loads the TENANT-SCOPED data the breadcrumb pickers need (clients + their
 * logos, and workflows with their owning client). The route-aware breadcrumb
 * itself lives in HeaderBar (a client component using usePathname), because a
 * root-layout server component renders once and would not update on client-side
 * navigation. Names are looked up from these tenant-scoped lists, so a foreign id
 * can never resolve to another tenant's entity.
 */
export async function AppHeader() {
  // Path comes from middleware's x-pathname header (data-layer, not trusted gate).
  const pathname = (await headers()).get("x-pathname") ?? "";
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  const session = await getServerSession();
  if (!session?.user) return null; // logged out → no header (the page itself bounces to /login)

  // Resolve the tenant without redirecting (the page's requireTenant owns that);
  // a tenant-less session simply renders no header.
  const tenantId = await getTenantIdForUser(session.user.id);
  if (!tenantId) return null;

  const [clients, workflows] = await Promise.all([
    listClientsForTenant(tenantId),
    listWorkflowsWithClientForTenant(tenantId),
  ]);

  const clientOptions: HeaderClient[] = clients.map((c) => ({
    id: c.id,
    name: c.name,
    isDefault: c.is_default,
    logoUrl: c.logo_url,
  }));
  const workflowOptions: HeaderWorkflow[] = workflows.map((w) => ({
    id: w.n8n_workflow_id,
    name: w.name,
    clientId: w.client_id,
  }));

  return (
    <HeaderBar
      email={session.user.email}
      name={session.user.name ?? null}
      clients={clientOptions}
      workflows={workflowOptions}
    />
  );
}
