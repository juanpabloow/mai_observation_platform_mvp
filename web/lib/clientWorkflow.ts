import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getWorkflowByN8nId } from "@worker/db/repositories/workflows.js";
import { getClientById, type ClientRow } from "@worker/db/repositories/clients.js";
import type { WorkflowRow } from "@worker/db/types.js";
import { getCurrentTenantId } from "./tenant";

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
    const tenantId = await getCurrentTenantId();

    const workflow = await getWorkflowByN8nId({ tenantId, n8nWorkflowId: workflowId });
    if (!workflow) return { kind: "not_found" };

    // client_id is NOT NULL since CL-1a; the guard is defensive (and narrows the
    // type, which still reads string | null).
    const ownerClientId = workflow.client_id;
    if (!ownerClientId) return { kind: "not_found" };

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
