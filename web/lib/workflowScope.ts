import "server-only";
import { cookies } from "next/headers";
import { getWorkflowByN8nId } from "@worker/db/repositories/workflows.js";
import { canAccessClient, type AccessScope } from "./access";
import { SCOPE_COOKIE, parseScopeMap, type ScopeMap } from "./scopeCookieShared";

/**
 * THE server-side source of truth for the per-client "current workflow" scope
 * (Phase W-1). Reads the `wf_scope` cookie (compact map, see scopeCookieShared) and
 * VALIDATES the remembered workflow against reality: it must still exist, still be
 * assigned to THIS client, and be accessible to THIS user. Anything invalid, stale,
 * or foreign resolves to 'all'. Pure resolution — it NEVER throws, NEVER writes a
 * cookie (writes are client-side per the spec), and NEVER redirects, so callers can
 * use it freely in server components without a redirect-loop risk.
 */

export type WorkflowScope = "all" | string;

/** Read + parse the scope cookie map (server). */
export async function readScopeMap(): Promise<ScopeMap> {
  const raw = (await cookies()).get(SCOPE_COOKIE)?.value;
  return parseScopeMap(raw);
}

/**
 * True iff `workflowId` still exists, is assigned to `clientId`, and `scope` may
 * access that client. This is the whole validity contract for a remembered scope; it
 * rejects a deleted/unassigned workflow (stale) and a workflow copied from another
 * client (foreign / cross-client), and — via canAccessClient — a client a member
 * can't see. Never throws (a DB hiccup ⇒ not valid ⇒ falls back to 'all').
 */
export async function validateWorkflowForClient(
  tenantId: string,
  clientId: string,
  workflowId: string,
  scope: AccessScope,
): Promise<boolean> {
  if (!workflowId) return false;
  if (!canAccessClient(scope, clientId)) return false;
  try {
    const wf = await getWorkflowByN8nId({ tenantId, n8nWorkflowId: workflowId });
    return Boolean(wf && wf.client_id === clientId);
  } catch {
    return false;
  }
}

/**
 * The remembered, VALIDATED scope for `clientId` — 'all' when nothing valid is
 * remembered. Callers: the workflows-list route (redirects to the workflow's
 * executions when this is a workflow), the server seed for non-URL surfaces (Inbox),
 * and anywhere that needs the effective scope server-side.
 */
export async function resolveWorkflowScope(
  tenantId: string,
  clientId: string,
  scope: AccessScope,
): Promise<WorkflowScope> {
  const candidate = (await readScopeMap())[clientId];
  if (!candidate) return "all";
  return (await validateWorkflowForClient(tenantId, clientId, candidate, scope)) ? candidate : "all";
}
