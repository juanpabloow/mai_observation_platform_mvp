import { headers } from "next/headers";
import { getServerSession } from "@/lib/session";
import { getSessionScope, memberLandingHref } from "@/lib/access";
import { listClientsForTenant } from "@worker/db/repositories/clients.js";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { HeaderBar, type HeaderClient, type HeaderWorkflow } from "./HeaderBar";

const AUTH_PREFIXES = ["/login", "/signup", "/logout"];

/**
 * Global app header (logo / breadcrumb / profile). SERVER component in the root
 * layout: it gates visibility (no header on the auth screens or when logged out)
 * and loads the data the breadcrumb pickers need (clients + their logos, and
 * workflows with their owning client). The route-aware breadcrumb itself lives in
 * HeaderBar (a client component using usePathname), because a root-layout server
 * component renders once and would not update on client-side navigation.
 *
 * RBAC: the lists are loaded tenant-scoped, then NARROWED to the user's access
 * scope — a member sees ONLY their one client (no client switcher) and only its
 * workflows. So the breadcrumb can never even name another client/workflow for a
 * member, and owner/admin are unaffected (memberClientId === null → no filter).
 */
export async function AppHeader() {
  // Path comes from middleware's x-pathname header (data-layer, not trusted gate).
  const pathname = (await headers()).get("x-pathname") ?? "";
  if (AUTH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }

  // Graceful (non-redirecting) scope read — the header renders null when logged
  // out / scope-less rather than redirecting (the page itself owns redirects).
  const scope = await getSessionScope();
  if (!scope) return null;
  const session = await getServerSession(); // cached — for the display name/email
  if (!session?.user) return null;

  const [clients, workflows] = await Promise.all([
    listClientsForTenant(scope.tenantId),
    listWorkflowsWithClientForTenant(scope.tenantId),
  ]);

  // Narrow to the access scope: a member sees only their client + its workflows.
  const memberClientId = scope.memberClientId;
  const visibleClients = memberClientId ? clients.filter((c) => c.id === memberClientId) : clients;
  const visibleWorkflows = memberClientId
    ? workflows.filter((w) => w.client_id === memberClientId)
    : workflows;

  const clientOptions: HeaderClient[] = visibleClients.map((c) => ({
    id: c.id,
    name: c.name,
    isDefault: c.is_default,
    logoUrl: c.logo_url,
  }));
  const workflowOptions: HeaderWorkflow[] = visibleWorkflows.map((w) => ({
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
      // A member can't switch clients (they have exactly one); the home logo and
      // any "/" target route them to their own client, not the (forbidden) Hub.
      canSwitchClients={memberClientId === null}
      homeHref={memberLandingHref(scope)}
    />
  );
}
