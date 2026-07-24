import { connection } from "next/server";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { getAgentSummary } from "@worker/db/repositories/handoff.js";
import { hasFullAccess } from "@/lib/access";
import { requireClientModulePage } from "@/lib/clientModuleAccess";
import { loadClientInboxList } from "@/lib/inboxData";
import { ClientInboxWorkspace } from "@/components/ClientInboxWorkspace";

/**
 * Client-level UNIFIED INBOX — an operative THREE-COLUMN workspace (list · chat ·
 * customer details). ONE tray for the live/handoff conversations of ALL the client's
 * canonical workflows, grouped by real state (Needs human attention / Human is
 * handling / Bot is handling), filterable by workflow, opening the chat via the
 * existing `?c=<conversationId>` deep link on this same route.
 *
 * Access is resolved from the SESSION, never the URL: getClientForTenant validates the
 * clientId is a real client of THIS tenant AND accessible to the user (owner/admin →
 * any of their clients; member → only their one client) — any other client is an
 * indistinguishable 404. The data layer (loadClientInboxList / the poll route) filters
 * by tenant+client at the SQL layer, so a foreign conversation is never listed and a
 * direct `?c=` to one 404s in the thread pane. All props handed to the (client)
 * workspace are serializable — no function crosses the RSC boundary.
 */
export default async function ClientInboxPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;

  // Gate: session + client of this tenant + NON-default + `inbox` module ENABLED.
  // Any failure (foreign/bogus/out-of-scope/default/disabled) is an indistinguishable
  // 404 — the same safe 404 every other client module uses.
  const { scope, client } = await requireClientModulePage(clientId, "inbox");

  const [initial, viewer, wfRows] = await Promise.all([
    loadClientInboxList(scope.tenantId, client.id),
    getAgentSummary(scope.userId),
    listWorkflowsWithClientForTenant(scope.tenantId),
  ]);

  // The workflow filter options — only THIS client's workflows, sorted by name. (No
  // other client's workflow ids/names are ever serialized to the browser.)
  const workflows = wfRows
    .filter((w) => w.client_id === client.id)
    .map((w) => ({ id: w.n8n_workflow_id, name: w.name }))
    .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));

  return (
    <ClientInboxWorkspace
      clientId={client.id}
      clientName={client.name}
      initial={initial}
      endpoint={`/api/inbox/${encodeURIComponent(client.id)}/conversations`}
      workflows={workflows}
      viewerUserId={scope.userId}
      viewerName={viewer?.name ?? null}
      viewerIsFullAccess={hasFullAccess(scope)}
    />
  );
}
