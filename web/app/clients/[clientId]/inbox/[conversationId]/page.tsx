import { connection } from "next/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccessScope, hasFullAccess } from "@/lib/access";
import { getClientForTenant } from "@/lib/clientWorkflow";
import { loadInboxThread } from "@/lib/inboxData";
import { InboxThread } from "@/components/InboxThread";

/**
 * Inbox thread view. Two data-layer guards: getClientForTenant (RBAC — the user can
 * see this client) AND loadInboxThread returning null unless the conversation belongs
 * to this client (a direct-URL probe of another client's conversation → 404). The
 * viewer's id + full-access flag drive which actions render (re-checked server-side).
 */
export default async function ClientInboxThreadPage({
  params,
}: {
  params: Promise<{ clientId: string; conversationId: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  const { clientId, conversationId } = await params;
  const client = await getClientForTenant(clientId);
  if (!client) notFound();

  const payload = await loadInboxThread(
    scope.tenantId,
    clientId,
    decodeURIComponent(conversationId),
  );
  if (!payload) notFound();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 px-6 py-8">
      <Link
        href={`/clients/${clientId}/inbox`}
        className="text-sm text-muted transition-colors hover:text-foreground"
      >
        &larr; Inbox
      </Link>
      <InboxThread
        clientId={clientId}
        initial={payload}
        viewerUserId={scope.userId}
        viewerIsFullAccess={hasFullAccess(scope)}
      />
    </main>
  );
}
