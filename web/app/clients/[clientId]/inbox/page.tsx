import { connection } from "next/server";
import { notFound } from "next/navigation";
import { listWorkflowsWithClientForTenant } from "@worker/db/repositories/workflows.js";
import { getAgentSummary } from "@worker/db/repositories/handoff.js";
import { getAccessScope, hasFullAccess } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { loadClientInboxList } from "@/lib/inboxData";
import { ConversationGrid } from "@/components/ConversationGrid";
import { InboxDrawer } from "@/components/InboxDrawer";

/**
 * Client-level UNIFIED INBOX (Phase 4A). ONE tray for the live/handoff conversations
 * of ALL the client's canonical workflows — each card labelled with its workflow and
 * filterable by workflow WITHOUT a full reload. It reuses the exact same grid + drawer
 * as the per-workflow inbox (no duplicate UI): the grid light-polls the client-level
 * endpoint and cards open the drawer via `?c=<conversationId>` on this same route.
 *
 * Access is resolved from the SESSION, never the URL: getClientForTenant validates the
 * clientId is a real client of THIS tenant AND accessible to the user (owner/admin →
 * any of their clients; member → only their one client) — any other client (foreign,
 * bogus, or out-of-a-member's-scope) is an indistinguishable 404. The data layer
 * (loadClientInboxList / the poll route) filters by tenant+client at the SQL layer, so
 * a foreign conversation is never listed and a direct `?c=` to one 404s in the drawer.
 */
export default async function ClientInboxPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const { clientId } = await params;

  const scope = await getAccessScope();
  const client = await getClientForTenant(clientId);
  if (!client) notFound(); // foreign / bogus / outside a member's scope → 404

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
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-6 py-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="mt-0.5 text-sm text-muted">
          Live and handed-off conversations across all of this client&rsquo;s workflows.
        </p>
      </header>

      <ConversationGrid
        clientId={client.id}
        initial={initial}
        endpoint={`/api/inbox/${encodeURIComponent(client.id)}/conversations`}
        workflows={workflows}
        // Serializable route selector (NOT a callback) — cards open the drawer via
        // ?c= on THIS same client-level route. Nothing non-serializable crosses here.
        conversationRoute="client"
      />
      <InboxDrawer
        clientId={client.id}
        viewerUserId={scope.userId}
        viewerName={viewer?.name ?? null}
        viewerIsFullAccess={hasFullAccess(scope)}
      />
    </main>
  );
}
