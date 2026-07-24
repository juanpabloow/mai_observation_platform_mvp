import { connection } from "next/server";
import { notFound, redirect } from "next/navigation";
import { getAccessScope, canAccessClient } from "@/lib/access";
import { getConversationForClient } from "@worker/db/repositories/handoff.js";
import { isUuid } from "@/lib/inboxData";

/**
 * COMPAT: the old client-level Inbox thread URL. Phase 4A makes the client Inbox a
 * real unified tray that opens threads via `?c=<id>` on /clients/<c>/inbox, so this
 * legacy path 307-redirects there — but only AFTER validating the conversation really
 * belongs to this tenant+client (foreign/bogus → 404, no existence disclosure). RBAC:
 * a member who can't see this client → not-found as well.
 */
export default async function OldClientInboxThreadRedirect({
  params,
}: {
  params: Promise<{ clientId: string; conversationId: string }>;
}) {
  await connection();
  const scope = await getAccessScope();
  const { clientId, conversationId } = await params;
  if (!canAccessClient(scope, clientId)) notFound();

  const id = decodeURIComponent(conversationId);
  if (!isUuid(id)) notFound();
  const conv = await getConversationForClient(scope.tenantId, clientId, id);
  if (!conv) notFound();

  redirect(`/clients/${clientId}/inbox?c=${encodeURIComponent(id)}`);
}
