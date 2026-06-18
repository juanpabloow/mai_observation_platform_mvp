import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getWorkflowByN8nId, listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { getClientById, type ClientRow } from "@worker/db/repositories/clients.js";
import type { WorkflowRow } from "@worker/db/types.js";
import { getAccessScope, canAccessClient } from "./access";

/**
 * Resolution of a (clientId, workflowId) URL pair against the current tenant.
 * The URL's clientId is NEVER trusted — the workflow's REAL client_id (resolved
 * tenant-scoped) is canonical, and the URL clientId is only validated against it.
 *
 *  - "ok"        — the URL clientId is the workflow's real client; render.
 *  - "mismatch"  — the workflow belongs to a DIFFERENT (but real, this-tenant)
 *                  client; the caller redirects to the canonical URL (handles a
 *                  stale bookmark after a workflow was reassigned).
 *  - "not_found" — the workflow isn't this tenant's, OR the URL clientId is a
 *                  bogus/foreign id (→ 404, so we never leak the real client).
 */
export type ClientWorkflowResolution =
  | { kind: "ok"; workflow: WorkflowRow; client: ClientRow }
  | { kind: "mismatch"; workflow: WorkflowRow; client: ClientRow; canonicalClientId: string }
  | { kind: "not_found" };

/**
 * Resolve a workflow under a client, tenant-scoped. Wrapped in React.cache so the
 * layout and the page beneath it (which both call this for the same params in one
 * render) share a single set of queries. Common case = 2 queries (workflow +
 * its client); a clientId mismatch costs one extra lookup.
 */
export const resolveWorkflowUnderClient = cache(
  async (urlClientId: string, workflowId: string): Promise<ClientWorkflowResolution> => {
    const scope = await getAccessScope();
    const tenantId = scope.tenantId;

    const workflow = await getWorkflowByN8nId({ tenantId, n8nWorkflowId: workflowId });
    if (!workflow) return { kind: "not_found" };

    // client_id is NOT NULL since CL-1a; the guard is defensive (and narrows the
    // type, which still reads string | null).
    const ownerClientId = workflow.client_id;
    if (!ownerClientId) return { kind: "not_found" };

    // RBAC (deny-by-default): a member may only see THEIR client's workflows. The
    // workflow's REAL client_id is what's checked — never the URL clientId — so
    // neither a forged URL segment nor a stale mismatch can widen a member's
    // access. A workflow under any other client is indistinguishable from a 404.
    if (!canAccessClient(scope, ownerClientId)) return { kind: "not_found" };

    if (ownerClientId === urlClientId) {
      const client = await getClientById({ tenantId, clientId: ownerClientId });
      if (!client) return { kind: "not_found" }; // FK guarantees this; defensive
      return { kind: "ok", workflow, client };
    }

    // Mismatch: only redirect for a real client of THIS tenant (stale bookmark).
    // A bogus/foreign clientId 404s so the real owner is never disclosed.
    const urlClient = await getClientById({ tenantId, clientId: urlClientId });
    if (!urlClient) return { kind: "not_found" };
    const canonical = await getClientById({ tenantId, clientId: ownerClientId });
    if (!canonical) return { kind: "not_found" };
    return { kind: "mismatch", workflow, client: canonical, canonicalClientId: ownerClientId };
  },
);

/**
 * Page helper: resolve the workflow, 404 if missing/bogus, or redirect to the
 * canonical client URL (preserving `search`) on a mismatch. Returns the workflow
 * row when the URL is canonical. `subpath` is this route's tail under the
 * workflow (e.g. "executions", "conversations/settings", `conversations/<id>`).
 */
export async function requireWorkflowUnderClient(
  urlClientId: string,
  workflowId: string,
  subpath: string,
  search = "",
): Promise<WorkflowRow> {
  const res = await resolveWorkflowUnderClient(urlClientId, workflowId);
  if (res.kind === "not_found") notFound();
  if (res.kind === "mismatch") {
    redirect(
      `/clients/${res.canonicalClientId}/workflows/${encodeURIComponent(workflowId)}/${subpath}${search}`,
    );
  }
  return res.workflow;
}

/**
 * Validate a clientId is the CURRENT tenant's AND accessible to the user, then
 * return it (the "all workflows" analytics view trusts no URL clientId). Cached
 * so a page + its helpers share one lookup. Returns null for a bogus/foreign
 * client OR a client outside a member's scope → the caller 404s (deny-by-default).
 */
export const getClientForTenant = cache(async (clientId: string): Promise<ClientRow | null> => {
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) return null; // RBAC: member → only their client
  return getClientById({ tenantId: scope.tenantId, clientId });
});

/**
 * Resolve which workflow the "All workflows" view's Executions/Conversations
 * links should land on: the remembered `from` workflow if it belongs to this
 * client, else the client's first workflow (by name), else null (no workflows /
 * bogus client → the caller sends the user back to /clients). Tenant-scoped — a
 * `from` from another client/tenant is ignored.
 */
export async function resolveRememberedWorkflow(
  clientId: string,
  from: string | undefined,
): Promise<string | null> {
  const scope = await getAccessScope();
  if (!canAccessClient(scope, clientId)) return null; // RBAC: member → only their client
  const tenantId = scope.tenantId;
  const client = await getClientById({ tenantId, clientId });
  if (!client) return null;
  const workflows = (await listWorkflowsWithClientForTenant(tenantId)).filter(
    (w) => w.client_id === clientId,
  );
  if (from && workflows.some((w) => w.n8n_workflow_id === from)) return from;
  if (workflows.length === 0) return null;
  return [...workflows].sort((a, b) =>
    (a.name ?? a.n8n_workflow_id).localeCompare(b.name ?? b.n8n_workflow_id),
  )[0].n8n_workflow_id;
}
