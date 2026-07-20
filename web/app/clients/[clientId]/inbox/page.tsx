import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccessScope } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { loadInboxList } from "@/lib/inboxData";
import { InboxList } from "@/components/InboxList";

/**
 * Client-level ATTENTION QUEUE (H-6) — replaces the old full client inbox at the same
 * route. Shows ONLY pending + human conversations across the client's workflows
 * (pending first), each linking into its workflow's Inbox thread. RBAC unchanged:
 * owner/admin any client, a member only their own; foreign/bogus → not-found.
 */
export default async function ClientAttentionQueuePage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  const { clientId } = await params;
  const client = await getClientForTenant(clientId);
  if (!client) notFound();

  const clientLabel = client.is_default ? "Unassigned" : client.name;
  const initial = await loadInboxList(scope.tenantId, clientId, "attention");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="space-y-1">
        <Link
          href={`/clients/${clientId}/workflows/all/analytics`}
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          &larr; {clientLabel}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{clientLabel} · Needs attention</h1>
        <p className="text-sm text-muted">
          Conversations across <span className="text-foreground">{clientLabel}</span>&rsquo;s
          workflows that are waiting for a human or currently with an agent. Open one to reply
          in its workflow inbox.
        </p>
      </div>

      <InboxList
        clientId={clientId}
        initial={initial}
        initialFilter="attention"
        endpoint={`/api/inbox/${clientId}/conversations`}
        filters={[]}
        showWorkflow
        emptyTitle="Needs attention"
        emptyMessage="Nothing needs attention — every conversation is bot-handled right now."
      />
    </main>
  );
}
