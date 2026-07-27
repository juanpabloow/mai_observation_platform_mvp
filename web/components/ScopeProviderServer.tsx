import { headers } from "next/headers";
import { getSessionScope } from "@/lib/access";
import { resolveWorkflowScope, validateWorkflowForClient } from "@/lib/workflowScope";
import { parseScopeSurface } from "@/lib/scopeSurface";
import type { ScopeMap } from "@/lib/scopeCookieShared";
import { ScopeProvider } from "./ScopeProvider";

/**
 * Server seed for the client ScopeProvider (Phase W-1). Resolves the CURRENT client's
 * effective scope once, at request time, so the first paint of the sidebar/header is
 * already correct (no flash) — the client provider then keeps it fresh.
 *
 * Only the current client (from the request path) is seeded; other clients default to
 * 'all' until visited (and their pages report their own scope). This keeps the seed a
 * single validated lookup and avoids trusting the raw cookie for the sidebar hrefs.
 *
 * URL WINS even at seed time: on a specific-workflow or explicit all-workflows URL the
 * seed reflects the URL (validated); on a non-URL scope surface (Inbox) or any other
 * client page it reflects the remembered, validated cookie scope. x-pathname is read
 * ONLY to compute this seed value (never to branch layout structure — the H-8.1 trap);
 * it is authoritative only at hard-load, where it is correct, and the client provider
 * owns every subsequent transition.
 */

function parseClientId(pathname: string): string | null {
  const m = pathname.match(/^\/clients\/([^/]+)(?:\/|$)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export async function ScopeProviderServer({ children }: { children: React.ReactNode }) {
  let initial: ScopeMap = {};

  const scope = await getSessionScope();
  if (scope) {
    const h = await headers();
    const pathname = h.get("x-pathname") ?? "";
    const search = h.get("x-search") ?? ""; // for the inbox's ?workflow= (W-2)
    const clientId = parseClientId(pathname);
    if (clientId) {
      const surface = parseScopeSurface(pathname, search);
      let resolved: "all" | string;
      if (surface && surface.urlWorkflow !== null) {
        resolved =
          surface.urlWorkflow === "all"
            ? "all"
            : (await validateWorkflowForClient(scope.tenantId, clientId, surface.urlWorkflow, scope))
              ? surface.urlWorkflow
              : "all";
      } else {
        resolved = await resolveWorkflowScope(scope.tenantId, clientId, scope);
      }
      if (resolved !== "all") initial = { [clientId]: resolved };
    }
  }

  return <ScopeProvider initial={initial}>{children}</ScopeProvider>;
}
