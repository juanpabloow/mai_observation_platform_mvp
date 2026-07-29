import { connection } from "next/server";
import { getAgentSummary, isWorkflowHandoffActive } from "@worker/db/repositories/handoff.js";
import { hasFullAccess } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { resolveWorkflowScope, validateWorkflowForClient } from "@/lib/workflowScope";
import { loadScopedClientInbox } from "@/lib/inboxData";
import { ClientInboxWorkspace } from "@/components/ClientInboxWorkspace";

type SearchParams = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Client-level UNIFIED INBOX — a THREE-COLUMN workspace (list · chat · customer
 * details). ONE tray for the live/handoff conversations of the client's workflows,
 * grouped by real state (Needs human attention / Human / Bot), opening the chat via the
 * existing `?c=<conversationId>` deep link.
 *
 * W-2: the list respects the W-1 workflow SCOPE — there is no in-panel workflow picker;
 * the header switcher is the only selector. The effective scope is URL-first
 * (?workflow=<id>, validated) then the remembered cookie; 'all' ⇒ every conversation,
 * a workflow ⇒ only its conversations. The scope is resolved HERE (server) and both the
 * initial list and the poll route filter at the data layer, so groups/counts/pending
 * are correct on first paint (no flash of the full list). The workspace is keyed by the
 * scope so a scope change re-seeds it with the already-scoped list.
 *
 * Access is the shared module gate (session + client-of-tenant + non-default + `inbox`
 * enabled) — any failure is an indistinguishable 404.
 */
export default async function ClientInboxPage({
  params,
  searchParams,
}: {
  params: Promise<{ clientId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  await connection();
  const { clientId } = await params;
  const { scope, client } = await requireClientModulePage(clientId, "inbox");

  // URL wins: ?workflow=<id> (validated to this client + accessible) else the cookie.
  const wfParam = first((await searchParams).workflow);
  let effective: "all" | string;
  if (wfParam && wfParam !== "all") {
    effective = (await validateWorkflowForClient(scope.tenantId, client.id, wfParam, scope))
      ? wfParam
      : "all";
  } else {
    effective = await resolveWorkflowScope(scope.tenantId, client.id, scope);
  }

  const [initial, viewer] = await Promise.all([
    loadScopedClientInbox(scope.tenantId, client.id, effective),
    getAgentSummary(scope.userId),
  ]);

  // Empty-state nuance (H-6): when a specific workflow is scoped but has NO conversations
  // yet, distinguish "not set up for handoff" from "set up but quiet" so the empty state
  // can point the operator at settings. One extra cheap query, only when the list is empty.
  const workflowHandoffActive =
    effective !== "all" && initial.conversations.length === 0
      ? await isWorkflowHandoffActive(scope.tenantId, effective)
      : null;

  return (
    <ClientInboxWorkspace
      key={effective}
      clientId={client.id}
      scope={effective}
      initial={initial}
      workflowHandoffActive={workflowHandoffActive}
      viewerUserId={scope.userId}
      viewerName={viewer?.name ?? null}
      viewerIsFullAccess={hasFullAccess(scope)}
    />
  );
}
