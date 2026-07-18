import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccessScope } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { loadInboxList } from "@/lib/inboxData";
import { InboxList } from "@/components/InboxList";

/**
 * Per-client Inbox (CLIENT level, like Team). RBAC: owner/admin see any client;
 * a member only their own (getClientForTenant returns null otherwise → 404, so the
 * URL is never trusted and other clients' existence is never disclosed). The initial
 * list is server-rendered; InboxList then light-polls the session-authed JSON route.
 */
export default async function ClientInboxPage({
  params,
}: {
  params: Promise<{ clientId: string }>;
}) {
  await connection();
  const scope = await getAccessScope(); // redirects if unauthenticated
  const { clientId } = await params;
  const client = await getClientForTenant(clientId); // tenant-scoped + RBAC; foreign → null
  if (!client) notFound();

  const clientLabel = client.is_default ? "Unassigned" : client.name;
  const initial = await loadInboxList(scope.tenantId, clientId, "all");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <div className="space-y-1">
        <Link
          href={`/clients/${clientId}/workflows/all/analytics`}
          className="text-sm text-muted transition-colors hover:text-foreground"
        >
          &larr; {clientLabel}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{clientLabel} · Inbox</h1>
        <p className="text-sm text-muted">
          Conversations across <span className="text-foreground">{clientLabel}</span>&rsquo;s
          workflows — bot-handled, pending a human, or taken by an agent. Take one to reply.
        </p>
      </div>

      <InboxList clientId={clientId} initial={initial} initialFilter="all" />
    </main>
  );
}
